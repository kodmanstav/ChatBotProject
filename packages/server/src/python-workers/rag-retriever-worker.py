#!/usr/bin/env python3
"""
RAG retriever worker: consumes tool-invocation-requests for getProductInformation,
simulates retrieval, publishes ToolInvocationResulted to conversation-events.
"""

import json
import logging
import sys
import os
from pathlib import Path
from datetime import datetime, timezone
from kafka import KafkaConsumer, KafkaProducer
from kafka.structs import OffsetAndMetadata, TopicPartition

import chromadb
from chromadb.utils import embedding_functions

logging.getLogger().handlers.clear()
logging.getLogger().setLevel(logging.CRITICAL)

logger = logging.getLogger(__name__)
logger.handlers.clear()
logger.setLevel(logging.INFO)
logger.propagate = False

handler = logging.StreamHandler(sys.stdout)
handler.setLevel(logging.INFO)


class LocalTimeFormatter(logging.Formatter):
    def formatTime(self, record, datefmt=None):
        return datetime.now().astimezone().isoformat(timespec="milliseconds")


handler.setFormatter(LocalTimeFormatter("%(asctime)s %(message)s"))
logger.addHandler(handler)

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BROKERS", "localhost:9092")
CONSUME_TOPIC = "tool-invocation-requests"
CONSUMER_GROUP = "rag-retriever-group"
PRODUCE_TOPIC = "conversation-events"
TOOL_NAME = "getProductInformation"

PROCESSED = set()

# Directory containing product data files (project-root/data/products)
PROJECT_ROOT = Path(os.getenv("PROJECT_ROOT", Path(__file__).resolve().parent.parent))
PRODUCTS_DIR = PROJECT_ROOT / "data" / "products"

# Chroma persistence
CHROMA_DIR = PROJECT_ROOT / ".chroma"
CHROMA_COLLECTION = "products"


def idempotency_key(conversation_id: str, step: int, tool: str) -> str:
    return f"{conversation_id}:{step}:{tool}"


def already_processed(conversation_id: str, step: int, tool: str) -> bool:
    return idempotency_key(conversation_id, step, tool) in PROCESSED


def mark_processed(conversation_id: str, step: int, tool: str) -> None:
    PROCESSED.add(idempotency_key(conversation_id, step, tool))


def build_offset_metadata(offset: int) -> OffsetAndMetadata:
    """
    Build OffsetAndMetadata across kafka-python versions.
    Newer versions require leader_epoch as a 3rd argument.
    """
    try:
        return OffsetAndMetadata(offset, "", -1)
    except TypeError:
        return OffsetAndMetadata(offset, "")


# --- ChromaDB helpers --------------------------------------------------------


def get_chroma_collection():
    """
    Create / load a persistent Chroma collection for products,
    with a SentenceTransformer embedding function.
    """
    CHROMA_DIR.mkdir(parents=True, exist_ok=True)

    client = chromadb.PersistentClient(path=str(CHROMA_DIR))

    embedding_fn = embedding_functions.SentenceTransformerEmbeddingFunction(
        model_name="all-MiniLM-L6-v2"
    )

    collection = client.get_or_create_collection(
        name=CHROMA_COLLECTION,
        embedding_function=embedding_fn,
    )
    return collection


def load_product_files() -> list[dict]:
    """
    Read product .txt files and return a list of dicts with id, text, metadata.
    """
    products: list[dict] = []

    if not PRODUCTS_DIR.exists():
        logger.warning("[RAG Worker] Products directory not found: %s", PRODUCTS_DIR)
        return products

    for path in sorted(PRODUCTS_DIR.glob("*.txt")):
        try:
            text = path.read_text(encoding="utf-8")
        except Exception as e:  # pragma: no cover
            logger.exception("[RAG Worker] Failed to read %s: %s", path, e)
            continue

        title = None
        for line in text.splitlines():
            if line.lower().startswith("product:"):
                title = line.split(":", 1)[1].strip()
                break

        prod_id = path.stem

        products.append(
            {
                "id": prod_id,
                "text": text,
                "metadata": {
                    "filename": path.name,
                    "title": title or path.stem,
                },
            }
        )

    logger.info("[RAG Worker] Found %d product files in %s", len(products), PRODUCTS_DIR)
    return products


def index_products_if_needed(collection) -> None:
    """
    Index products into Chroma, skipping ones that already exist by id.
    """
    products = load_product_files()
    if not products:
        return

    try:
        existing = collection.get()
        existing_ids = set(existing.get("ids", []))
    except Exception as e:  # pragma: no cover
        logger.warning("[RAG Worker] Failed to read existing Chroma IDs: %s", e)
        existing_ids = set()

    new_ids = []
    new_texts = []
    new_metadatas = []

    for prod in products:
        if prod["id"] in existing_ids:
            continue
        new_ids.append(prod["id"])
        new_texts.append(prod["text"])
        new_metadatas.append(prod["metadata"])

    if not new_ids:
        logger.info("[RAG Worker] No new products to index in Chroma.")
        return

    logger.info(
        "[RAG Worker] Indexing %d new products into Chroma collection '%s'",
        len(new_ids),
        CHROMA_COLLECTION,
    )

    collection.add(ids=new_ids, documents=new_texts, metadatas=new_metadatas)


def retrieve_products_from_chroma(collection, query: str, n_results: int = 3) -> list[dict]:
    """
    Given a query string, return top matching products from Chroma.
    """
    q = (query or "").strip()
    if not q:
        return []

    try:
        res = collection.query(query_texts=[q], n_results=max(1, n_results))
    except Exception as e:  # pragma: no cover
        logger.exception("[RAG Worker] Chroma query failed: %s", e)
        return []

    ids = res.get("ids") or []
    docs = res.get("documents") or []
    metas = res.get("metadatas") or []

    if not ids or not ids[0]:
        return []

    hits: list[dict] = []
    for i in range(len(ids[0])):
        text = docs[0][i] if docs and docs[0] and i < len(docs[0]) else ""
        meta = metas[0][i] if metas and metas[0] and i < len(metas[0]) else {}
        hits.append({"text": text, "metadata": meta})

    return hits


def retrieve_products_from_files(query: str, max_results: int = 3) -> list[dict]:
    """
    Fallback retrieval without embeddings startup.
    Scores local product files by keyword overlap and returns top matches.
    """
    products = load_product_files()
    if not products:
        return []

    q = (query or "").lower()
    tokens = [t for t in q.replace("-", " ").split() if len(t) > 2]
    scored: list[tuple[int, dict]] = []

    for item in products:
        text = (item.get("text") or "").lower()
        title = str((item.get("metadata") or {}).get("title") or "").lower()
        score = 0

        for token in tokens:
            if token in title:
                score += 3
            if token in text:
                score += 1

        if not tokens:
            score = 1

        scored.append((score, item))

    scored.sort(key=lambda x: x[0], reverse=True)
    top = [item for score, item in scored if score > 0][: max(1, max_results)]

    return [
        {
            "text": item.get("text") or "",
            "metadata": {**(item.get("metadata") or {}), "source": "local-files-fallback"},
        }
        for item in top
    ]


def extract_first_number(text: str) -> float | None:
    """
    Extract first numeric value from text.
    Generic helper for any numeric field (price, battery hours, etc).
    """
    import re

    if not text:
        return None

    m = re.search(r"([0-9][0-9,]*(?:\.[0-9]+)?)", text)
    if not m:
        return None
    raw = m.group(1).replace(",", "")
    try:
        return float(raw)
    except ValueError:
        return None


def normalize_field_key(raw_key: str) -> str:
    k = (raw_key or "").strip().lower()
    return "_".join(part for part in k.replace("-", " ").split() if part)


def parse_sections(text: str) -> dict[str, str]:
    """
    Parse simple "Section:" blocks from product text into a dictionary.
    Example keys: description, features, battery, compatibility, price.
    """
    sections: dict[str, str] = {}
    current_key: str | None = None
    buffer: list[str] = []

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line.endswith(":") and len(line) > 1 and line[:-1].strip():
            if current_key is not None:
                sections[current_key] = "\n".join(buffer).strip()
            current_key = normalize_field_key(line[:-1])
            buffer = []
            continue
        if current_key is not None:
            buffer.append(raw_line)

    if current_key is not None:
        sections[current_key] = "\n".join(buffer).strip()

    return {k: v for k, v in sections.items() if v}


def detect_requested_section_key(query: str, section_keys: list[str]) -> str | None:
    """
    Try to infer which section is requested by the query, based on section keys.
    """
    q = (query or "").lower().replace("-", " ")
    q_tokens_raw = [t for t in q.split() if len(t) > 1]
    q_tokens = []
    for t in q_tokens_raw:
        q_tokens.append(t)
        if len(t) > 3 and t.endswith("s"):
            q_tokens.append(t[:-1])  # simple plural -> singular normalization
    if not q_tokens or not section_keys:
        return None

    section_aliases: dict[str, list[str]] = {
        "price": ["price", "prices", "cost", "costs", "how much", "כמה", "מחיר", "מחירים"],
        "features": ["feature", "features", "spec", "specs", "capabilities", "מאפיינים", "תכונות"],
        "battery": ["battery", "power", "סוללה", "חיי סוללה"],
        "compatibility": ["compatibility", "compatible", "support", "works with", "תאימות", "תומך"],
        "description": ["description", "details", "overview", "about", "תיאור", "פרטים"],
    }

    scored: list[tuple[int, str]] = []
    for key in section_keys:
        key_norm = key.replace("_", " ").lower()
        key_tokens = [t for t in key_norm.split() if len(t) > 2]
        score = 0
        for token in q_tokens:
            if token in key_tokens:
                score += 2
            elif token in key_norm:
                score += 1
            elif any(token in kt or kt in token for kt in key_tokens):
                score += 1

        aliases = section_aliases.get(key, [])
        q_joined = " ".join(q_tokens)
        for alias in aliases:
            alias_norm = alias.lower()
            if alias_norm in q_joined:
                score += 2
        if score > 0:
            scored.append((score, key))

    if not scored:
        return None
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored[0][1]


def extract_focus_field_from_query(text: str, query: str) -> tuple[str, str] | None:
    """
    Try to map user query to a relevant section from the product text.
    This is generic and not tied to a single category.
    """
    sections = parse_sections(text)
    if not sections:
        return None

    q = (query or "").lower()
    q_tokens = [t for t in q.replace("-", " ").split() if len(t) > 2]
    if not q_tokens:
        return None

    requested = detect_requested_section_key(q, list(sections.keys()))
    if requested is None:
        return None
    value = sections.get(requested)
    if not value:
        return None
    return requested, value


def is_catalog_question(query: str) -> bool:
    """
    Heuristic check: is the user asking for available products/list/catalog?
    Supports simple English + a bit of Hebrew.
    """
    q = (query or "").lower()
    keywords = [
        "all products",
        "all the products",
        "all your products",
        "products you have",
        "what products",
        "which products",
        "list products",
        "available products",
        "catalog",
        "show products",
        "what do you have",
        "איזה מוצרים",
        "אילו מוצרים",
        "כל המוצרים",
        "כל המוצרים שיש",
        "רשימת מוצרים",
        "מה יש לכם",
    ]
    return any(kw in q for kw in keywords)


def is_total_cost_question(query: str) -> bool:
    q = (query or "").lower()
    keywords = [
        "total",
        "sum",
        "altogether",
        "overall",
        "total cost",
        "כמה יעלה הכל",
        "סך הכל",
        "עלות כוללת",
        "מחיר כולל",
    ]
    return any(kw in q for kw in keywords)


def extract_number_from_money_text(text: str) -> float | None:
    return extract_first_number(text)


def build_product_catalog_text(products: list[dict]) -> str:
    """
    Build a user-facing product list from local product files.
    """
    if not products:
        return "No product data available."

    titles = []
    for item in products:
        title = str((item.get("metadata") or {}).get("title") or "").strip()
        if title:
            titles.append(title)
    if not titles:
        return "No product data available."

    lines = [f"- {title}" for title in sorted(set(titles))]
    return "Available products:\n" + "\n".join(lines)


def build_product_section_catalog_text(products: list[dict], section_key: str) -> str:
    """
    Build a user-facing list for a specific section across all products.
    """
    if not products:
        return "No product data available."

    lines = []
    for item in products:
        text = str(item.get("text") or "")
        title = str((item.get("metadata") or {}).get("title") or "").strip()
        if not title:
            continue

        sections = parse_sections(text)
        section_value = sections.get(section_key)
        if section_value:
            one_line = section_value.splitlines()[0].strip()
            lines.append(f"- {title}: {one_line if one_line else section_value}")
        else:
            lines.append(f"- {title}: {section_key} not available")

    if not lines:
        return "No product data available."

    label = section_key.replace("_", " ")
    return f"Available product {label}:\n" + "\n".join(sorted(set(lines)))


def build_catalog_field_items(products: list[dict], section_key: str) -> list[dict]:
    items: list[dict] = []
    for item in products:
        text = str(item.get("text") or "")
        title = str((item.get("metadata") or {}).get("title") or "").strip()
        if not title:
            continue
        sections = parse_sections(text)
        section_value = sections.get(section_key)
        if not section_value:
            continue
        numeric = extract_number_from_money_text(section_value)
        row = {"title": title, "value_text": section_value}
        if numeric is not None:
            row["value"] = numeric
        items.append(row)
    return items


def build_multi_product_context(hits: list[dict], max_chars_per_product: int = 900) -> str:
    """
    Build a compact context from multiple product matches.
    """
    if not hits:
        return "No product data available."

    chunks = []
    for idx, hit in enumerate(hits, start=1):
        text = str(hit.get("text") or "").strip()
        meta = hit.get("metadata") or {}
        title = str(meta.get("title") or f"Product {idx}").strip()
        excerpt = text[:max_chars_per_product].strip()
        chunks.append(f"Product match {idx}: {title}\n{excerpt}")

    return "\n\n---\n\n".join(chunks)


def parse_message(value: bytes) -> dict | None:
    try:
        data = json.loads(value.decode("utf-8"))
        if not isinstance(data, dict):
            return None
        if data.get("eventType") != "ToolInvocationRequested":
            return None
        if "conversationId" not in data or "payload" not in data:
            return None
        payload = data["payload"]
        if not isinstance(payload, dict) or payload.get("tool") != TOOL_NAME:
            return None
        return data
    except (json.JSONDecodeError, UnicodeDecodeError, TypeError):
        return None


def simulate_retrieval(collection, parameters: dict) -> dict:
    """
    Retrieve product information from ChromaDB using semantic search.
    """
    query = parameters.get("query") or parameters.get("q") or "product"
    q_str = str(query)

    if is_catalog_question(q_str):
        products = load_product_files()
        section_keys = sorted(
            {
                key
                for p in products
                for key in parse_sections(str(p.get("text") or "")).keys()
            }
        )
        requested_section = detect_requested_section_key(q_str, section_keys)
        if requested_section is not None:
            items = build_catalog_field_items(products, requested_section)
            total_value = None
            if is_total_cost_question(q_str):
                numeric_values = [
                    float(row["value"]) for row in items if isinstance(row.get("value"), (int, float))
                ]
                if numeric_values:
                    total_value = sum(numeric_values)
            return {
                "retrieved_context": build_product_section_catalog_text(
                    products, requested_section
                ),
                "metadata": {
                    "answer_type": "catalog_field",
                    "field": requested_section,
                    "source": "local-files-fallback",
                },
                "query": q_str,
                "items": items,
                **({"total_value": total_value} if total_value is not None else {}),
            }
        return {
            "retrieved_context": build_product_catalog_text(products),
            "metadata": {"answer_type": "catalog", "source": "local-files-fallback"},
            "query": q_str,
        }

    hits: list[dict] = []
    if collection is not None:
        hits = retrieve_products_from_chroma(collection, q_str, n_results=3)
    if not hits:
        hits = retrieve_products_from_files(q_str, max_results=3)
    if not hits:
        retrieved = "No product data available."
        meta: dict = {}
    else:
        best = hits[0]
        best_text = str(best.get("text") or "")
        focused = extract_focus_field_from_query(best_text, q_str)
        if focused is not None:
            field_key, field_value = focused
            best_meta = best.get("metadata") or {}
            out = {
                "retrieved_context": field_value,
                "metadata": {
                    **best_meta,
                    "answer_type": "focused_field",
                    "field": field_key,
                },
                "query": q_str,
                field_key: field_value,
            }
            num = extract_first_number(field_value)
            if num is not None:
                out["value"] = num
            return out

        retrieved = build_multi_product_context(hits)
        titles = [
            str((h.get("metadata") or {}).get("title") or "").strip()
            for h in hits
            if (h.get("metadata") or {}).get("title")
        ]
        meta = {
            "answer_type": "product_context",
            "matched_products": titles,
            "match_count": len(hits),
        }

    return {
        "retrieved_context": retrieved,
        "metadata": meta,
        "query": q_str,
    }


def main():
    consumer = KafkaConsumer(
        CONSUME_TOPIC,
        bootstrap_servers=KAFKA_BOOTSTRAP,
        group_id=CONSUMER_GROUP,
        auto_offset_reset="earliest",
        enable_auto_commit=False,
        value_deserializer=lambda v: v,
    )
    producer = KafkaProducer(
        bootstrap_servers=KAFKA_BOOTSTRAP,
        value_serializer=lambda v: json.dumps(v).encode("utf-8"),
    )

    # Initialize Chroma + product indexing at startup.
    # If initialization fails, keep serving with local-file fallback.
    collection = None
    try:
        logger.info("[RAG Worker] Initializing Chroma collection: %s", CHROMA_COLLECTION)
        collection = get_chroma_collection()
        index_products_if_needed(collection)
        logger.info("[RAG Worker] Chroma retrieval enabled")
    except Exception as e:
        collection = None
        logger.warning(
            "[RAG Worker] Chroma initialization failed, using local file fallback only: %s",
            str(e),
        )

    logger.info("[RAG Worker] Consuming %s for tool %s", CONSUME_TOPIC, TOOL_NAME)

    for message in consumer:
        raw = message.value
        if raw is None:
            continue
        msg = parse_message(raw)
        if msg is None:
            continue

        conversation_id = msg.get("conversationId", "")
        timestamp = msg.get("timestamp", "")
        payload = msg.get("payload") or {}
        step = payload.get("step", 0)
        parameters = payload.get("parameters") or {}

        if already_processed(conversation_id, step, TOOL_NAME):
            logger.info(
                "[RAG Worker] Skipping duplicate conversationId=%s step=%s tool=%s",
                conversation_id,
                step,
                TOOL_NAME,
            )
            continue

        logger.info(
            "[RAG Worker] Received ToolInvocationRequested conversationId=%s step=%s tool=%s",
            conversation_id,
            step,
            TOOL_NAME,
        )

        try:
            result = simulate_retrieval(collection, parameters)
            ts = datetime.now(timezone.utc).isoformat()
            out = {
                "eventType": "ToolInvocationResulted",
                "conversationId": conversation_id,
                "timestamp": ts,
                "payload": {
                    "step": step,
                    "tool": TOOL_NAME,
                    "success": True,
                    "result": result,
                },
            }
            producer.send(PRODUCE_TOPIC, value=out)
            producer.flush()
            mark_processed(conversation_id, step, TOOL_NAME)
            logger.info(
                "[RAG Worker] Published ToolInvocationResulted conversationId=%s step=%s tool=%s",
                conversation_id,
                step,
                TOOL_NAME,
            )
            tp = TopicPartition(CONSUME_TOPIC, message.partition)
            consumer.commit(offsets={tp: build_offset_metadata(message.offset + 1)})
        except Exception as e:
            logger.exception("[RAG Worker] Error: %s", e)
            ts = datetime.now(timezone.utc).isoformat()
            out = {
                "eventType": "ToolInvocationResulted",
                "conversationId": conversation_id,
                "timestamp": ts,
                "payload": {
                    "step": step,
                    "tool": TOOL_NAME,
                    "success": False,
                    "result": {},
                    "error": str(e),
                },
            }
            try:
                producer.send(PRODUCE_TOPIC, value=out)
            except Exception:
                pass
            producer.flush()
            mark_processed(conversation_id, step, TOOL_NAME)
            logger.info(
                "[RAG Worker] Published ToolInvocationResulted (failed) conversationId=%s step=%s tool=%s error=%s",
                conversation_id,
                step,
                TOOL_NAME,
                str(e),
            )
            tp = TopicPartition(CONSUME_TOPIC, message.partition)
            consumer.commit(offsets={tp: build_offset_metadata(message.offset + 1)})


if __name__ == "__main__":
    main()
