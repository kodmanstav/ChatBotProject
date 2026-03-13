#!/usr/bin/env python3
"""
Urgency worker: consumes from sanitized-messages, runs zero-shot classification,
publishes to analysis-urgency.
"""

import json
import logging
import sys
from kafka import KafkaConsumer, KafkaProducer
from transformers import pipeline

logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BROKERS", "localhost:9092")
CONSUME_TOPIC = "sanitized-messages"
CONSUMER_GROUP = "urgency-group"
PRODUCE_TOPIC = "analysis-urgency"
URGENCY_MODEL = "facebook/bart-large-mnli"
CATEGORY_LABELS = ["Urgent", "Complaint", "General Inquiry"]


def load_urgency_pipeline():
    return pipeline(
        "zero-shot-classification",
        model=URGENCY_MODEL,
    )


def parse_message(value: bytes) -> dict | None:
    try:
        data = json.loads(value.decode("utf-8"))
        if not isinstance(data, dict):
            return None
        if "id" not in data or "text" not in data or "timestamp" not in data:
            return None
        return data
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def run_urgency(pipe, text: str) -> tuple[str, float]:
    result = pipe(
        text[:512] if text else "",
        candidate_labels=CATEGORY_LABELS,
        multi_label=False,
        truncation=True,
    )
    label = result["labels"][0]
    score = float(result["scores"][0])
    return label, score


def main():
    logger.info("[UrgencyWorker] Loading model %s...", URGENCY_MODEL)
    urgency_pipe = load_urgency_pipeline()

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

    logger.info(
        "[UrgencyWorker] Consuming from %s (group=%s), producing to %s",
        CONSUME_TOPIC,
        CONSUMER_GROUP,
        PRODUCE_TOPIC,
    )

    for message in consumer:
        raw = message.value
        if raw is None:
            continue
        msg = parse_message(raw)
        if msg is None:
            logger.warning("[UrgencyWorker] Invalid message, skipping")
            continue

        logger.info("[UrgencyWorker] Received message")
        text = msg.get("text", "")
        msg_id = msg.get("id", "")
        timestamp = msg.get("timestamp", "")

        try:
            category, confidence = run_urgency(urgency_pipe, text)
        except Exception as e:
            logger.exception("[UrgencyWorker] Urgency classification failed: %s", e)
            continue

        logger.info("[UrgencyWorker] Category: %s (%.2f)", category, confidence)

        payload = {
            "id": msg_id,
            "text": text,
            "category": category,
            "confidence": confidence,
            "timestamp": timestamp,
        }
        try:
            producer.send(PRODUCE_TOPIC, value=payload)
            producer.flush()
            logger.info("[UrgencyWorker] Published to %s", PRODUCE_TOPIC)
        except Exception as e:
            logger.exception("[UrgencyWorker] Publish failed: %s", e)


if __name__ == "__main__":
    main()
