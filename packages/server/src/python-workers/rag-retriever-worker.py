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

logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
logger = logging.getLogger(__name__)

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


def retrieve_product_from_chroma(collection, query: str) -> dict | None:
    """
    Given a query string, return the best matching product from Chroma.
    """
    q = (query or "").strip()
    if not q:
        return None

    try:
        res = collection.query(query_texts=[q], n_results=1)
    except Exception as e:  # pragma: no cover
        logger.exception("[RAG Worker] Chroma query failed: %s", e)
        return None

    ids = res.get("ids") or []
    docs = res.get("documents") or []
    metas = res.get("metadatas") or []

    if not ids or not ids[0]:
        return None

    text = docs[0][0] if docs and docs[0] else ""
    meta = metas[0][0] if metas and metas[0] else {}

    return {"text": text, "metadata": meta}


def is_price_question(query: str) -> bool:
    """
    Heuristic check: is the user asking specifically about the price/cost?
    Supports simple English + a bit of Hebrew.
    """
    q = (query or "").lower()
    keywords = [
        "price",
        "how much",
        "cost",
        "כמה",
        "מה המחיר",
    ]
    return any(kw in q for kw in keywords)


def extract_price_line(text: str) -> str | None:
    """
    Given a product description text, try to extract the price line.
    Assumes a structure like:

    Price:
    Starting at $1,499
    """
    lines = text.splitlines()
    # Look for a "Price:" section, then take the first non-empty line after it
    for i, line in enumerate(lines):
        if line.strip().lower().startswith("price:"):
            for j in range(i + 1, len(lines)):
                candidate = lines[j].strip()
                if candidate:
                    return candidate

    # Fallback: search for a line containing a dollar sign
    for line in lines:
        if "$" in line:
            return line.strip()

    return None


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

    hit = retrieve_product_from_chroma(collection, q_str)
    if hit is None:
        retrieved = "No product data available."
        meta: dict = {}
    else:
        full_text = hit.get("text") or ""
        meta = hit.get("metadata") or {}

        # If the user asks specifically for the price, try to return only the price line
        if is_price_question(q_str):
            price_line = extract_price_line(full_text)
            if price_line:
                retrieved = price_line
                meta = {**meta, "answer_type": "price"}
            else:
                # Fallback: return full text if we couldn't safely extract a price
                retrieved = full_text
        else:
            retrieved = full_text

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

    # Setup Chroma and index products once at startup
    collection = get_chroma_collection()
    index_products_if_needed(collection)

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
            consumer.commit(offsets={tp: OffsetAndMetadata(message.offset + 1, "")})
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
            consumer.commit(offsets={tp: OffsetAndMetadata(message.offset + 1, "")})


if __name__ == "__main__":
    main()
