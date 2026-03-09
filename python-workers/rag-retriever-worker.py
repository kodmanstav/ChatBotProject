#!/usr/bin/env python3
"""
RAG retriever worker: consumes tool-invocation-requests for getProductInformation,
simulates retrieval, publishes ToolInvocationResulted to conversation-events.
"""

import json
import logging
import sys
from pathlib import Path
from datetime import datetime, timezone
from kafka import KafkaConsumer, KafkaProducer

logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
logger = logging.getLogger(__name__)

KAFKA_BOOTSTRAP = "localhost:9092"
CONSUME_TOPIC = "tool-invocation-requests"
CONSUMER_GROUP = "rag-retriever-group"
PRODUCE_TOPIC = "conversation-events"
TOOL_NAME = "getProductInformation"

PROCESSED = set()

# Directory containing product data files (project-root/data/products)
PROJECT_ROOT = Path(__file__).resolve().parent.parent
PRODUCTS_DIR = PROJECT_ROOT / "data" / "products"

# In-memory index of loaded product files
PRODUCT_INDEX: list[dict] = []


def idempotency_key(conversation_id: str, step: int, tool: str) -> str:
    return f"{conversation_id}:{step}:{tool}"


def already_processed(conversation_id: str, step: int, tool: str) -> bool:
    return idempotency_key(conversation_id, step, tool) in PROCESSED


def mark_processed(conversation_id: str, step: int, tool: str) -> None:
    PROCESSED.add(idempotency_key(conversation_id, step, tool))


def load_product_index() -> None:
    """
    Load all product text files from PRODUCTS_DIR into memory.
    """
    global PRODUCT_INDEX
    PRODUCT_INDEX = []

    if not PRODUCTS_DIR.exists():
        logger.warning("[RAG Worker] Products directory not found: %s", PRODUCTS_DIR)
        return

    for path in sorted(PRODUCTS_DIR.glob("*.txt")):
        try:
            text = path.read_text(encoding="utf-8")
        except Exception as e:  # pragma: no cover - defensive logging
            logger.exception("[RAG Worker] Failed to read %s: %s", path, e)
            continue

        title = None
        for line in text.splitlines():
            if line.lower().startswith("product:"):
                title = line.split(":", 1)[1].strip()
                break

        PRODUCT_INDEX.append(
            {
                "filename": path.name,
                "title": title or path.stem,
                "text": text,
            }
        )

    logger.info(
        "[RAG Worker] Loaded %d product files from %s",
        len(PRODUCT_INDEX),
        PRODUCTS_DIR,
    )


def choose_best_product(query: str) -> dict | None:
    """
    Very simple retrieval: choose the product whose title/filename/content
    best matches the query using a naive keyword score.
    """
    if not PRODUCT_INDEX:
        return None

    q = (query or "").lower().strip()
    if not q:
        return PRODUCT_INDEX[0]

    best = None
    best_score = -1

    for item in PRODUCT_INDEX:
        score = 0
        title = (item.get("title") or "").lower()
        filename = (item.get("filename") or "").lower()
        text = (item.get("text") or "").lower()

        # Direct matches on title or filename get higher weight
        if title and title in q:
            score += 5
        if filename.replace(".txt", "") in q:
            score += 4

        # Keyword overlap in content
        for word in q.split():
            if len(word) < 3:
                continue
            if word in title:
                score += 2
            if word in text:
                score += 1

        if score > best_score:
            best_score = score
            best = item

    return best or PRODUCT_INDEX[0]


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


def simulate_retrieval(parameters: dict) -> dict:
    """
    Retrieve product information from local data/products/*.txt files.
    """
    query = parameters.get("query") or parameters.get("q") or "product"

    product = choose_best_product(str(query))
    if product is None:
        retrieved = "No product data available."
    else:
        retrieved = product.get("text") or ""

    return {
        "retrieved_context": retrieved,
    }


def main():
    consumer = KafkaConsumer(
        CONSUME_TOPIC,
        bootstrap_servers=KAFKA_BOOTSTRAP,
        group_id=CONSUMER_GROUP,
        auto_offset_reset="latest",
        value_deserializer=lambda v: v,
    )
    producer = KafkaProducer(
        bootstrap_servers=KAFKA_BOOTSTRAP,
        value_serializer=lambda v: json.dumps(v).encode("utf-8"),
    )

    load_product_index()

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
            logger.info("[RAG Worker] Skipping duplicate request %s step %s", conversation_id, step)
            continue

        logger.info("[RAG Worker] Received ToolInvocationRequested for %s", TOOL_NAME)

        try:
            result = simulate_retrieval(parameters)
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
            logger.info("[RAG Worker] Published ToolInvocationResulted")
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


if __name__ == "__main__":
    main()
