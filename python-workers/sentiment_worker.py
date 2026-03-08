#!/usr/bin/env python3
"""
Sentiment worker: consumes from sanitized-messages, runs sentiment analysis,
publishes to analysis-sentiment.
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

KAFKA_BOOTSTRAP = "localhost:9092"
CONSUME_TOPIC = "sanitized-messages"
CONSUMER_GROUP = "sentiment-group"
PRODUCE_TOPIC = "analysis-sentiment"
SENTIMENT_MODEL = "distilbert-base-uncased-finetuned-sst-2-english"


def load_sentiment_pipeline():
    return pipeline(
        "sentiment-analysis",
        model=SENTIMENT_MODEL,
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


def run_sentiment(pipe, text: str) -> tuple[str, float]:
    result = pipe(text[:512], truncation=True)[0]
    label = result["label"].upper()
    if label not in ("POSITIVE", "NEGATIVE"):
        label = "POSITIVE" if result["score"] >= 0.5 else "NEGATIVE"
    return label, float(result["score"])


def main():
    logger.info("[SentimentWorker] Loading model %s...", SENTIMENT_MODEL)
    sentiment_pipe = load_sentiment_pipeline()

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
        "[SentimentWorker] Consuming from %s (group=%s), producing to %s",
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
            logger.warning("[SentimentWorker] Invalid message, skipping")
            continue

        logger.info("[SentimentWorker] Received message")
        text = msg.get("text", "")
        msg_id = msg.get("id", "")
        timestamp = msg.get("timestamp", "")

        try:
            sentiment, confidence = run_sentiment(sentiment_pipe, text)
        except Exception as e:
            logger.exception("[SentimentWorker] Sentiment analysis failed: %s", e)
            continue

        logger.info("[SentimentWorker] Sentiment: %s (%.2f)", sentiment, confidence)

        payload = {
            "id": msg_id,
            "text": text,
            "sentiment": sentiment,
            "confidence": confidence,
            "timestamp": timestamp,
        }
        try:
            producer.send(PRODUCE_TOPIC, value=payload)
            producer.flush()
            logger.info("[SentimentWorker] Published to %s", PRODUCE_TOPIC)
        except Exception as e:
            logger.exception("[SentimentWorker] Publish failed: %s", e)


if __name__ == "__main__":
    main()
