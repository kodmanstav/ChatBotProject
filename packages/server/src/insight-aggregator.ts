import { Kafka } from 'kafkajs';
import { safeJsonParse } from './utils/json';

// --- Constants ---

const KAFKA_BROKERS = [process.env.KAFKA_BROKERS || 'localhost:9092'];
const SENTIMENT_TOPIC = 'analysis-sentiment';
const URGENCY_TOPIC = 'analysis-urgency';
const CONSUMER_GROUP = 'insight-aggregator-group';
const STALE_ENTRY_MS = 5 * 60 * 1000; // 5 minutes

const RED_ANSI = '\x1b[31m';
const RESET_ANSI = '\x1b[0m';

// --- Types ---

interface SentimentMessage {
   id: string;
   text: string;
   sentiment: 'POSITIVE' | 'NEGATIVE';
   confidence: number;
   timestamp: string;
}

interface UrgencyMessage {
   id: string;
   text: string;
   category: 'Urgent' | 'Complaint' | 'General Inquiry';
   confidence: number;
   timestamp: string;
}

interface PartialInsight {
   sentiment?: { sentiment: 'POSITIVE' | 'NEGATIVE'; confidence: number };
   urgency?: {
      category: 'Urgent' | 'Complaint' | 'General Inquiry';
      confidence: number;
   };
   text?: string;
   timestamp?: string;
   lastUpdated?: number;
}

interface FullInsight {
   id: string;
   text: string;
   timestamp: string;
   sentiment: 'POSITIVE' | 'NEGATIVE';
   sentimentConfidence: number;
   urgency: 'Urgent' | 'Complaint' | 'General Inquiry';
   urgencyConfidence: number;
}

// --- State ---

const partialById = new Map<string, PartialInsight>();

// --- Type guards ---

function isSentimentMessage(obj: unknown): obj is SentimentMessage {
   if (obj == null || typeof obj !== 'object') return false;
   const o = obj as Record<string, unknown>;
   return (
      typeof o.id === 'string' &&
      typeof o.text === 'string' &&
      (o.sentiment === 'POSITIVE' || o.sentiment === 'NEGATIVE') &&
      typeof o.confidence === 'number' &&
      !Number.isNaN(o.confidence) &&
      typeof o.timestamp === 'string'
   );
}

function isUrgencyMessage(obj: unknown): obj is UrgencyMessage {
   if (obj == null || typeof obj !== 'object') return false;
   const o = obj as Record<string, unknown>;
   const validCategories = ['Urgent', 'Complaint', 'General Inquiry'];
   return (
      typeof o.id === 'string' &&
      typeof o.text === 'string' &&
      typeof o.category === 'string' &&
      validCategories.includes(o.category) &&
      typeof o.confidence === 'number' &&
      !Number.isNaN(o.confidence) &&
      typeof o.timestamp === 'string'
   );
}

// --- Helpers ---

function updatePartialState(
   id: string,
   partial: Partial<PartialInsight>,
   topic: string
): void {
   let entry = partialById.get(id);
   if (!entry) {
      entry = {};
      partialById.set(id, entry);
   }
   if (partial.sentiment != null) {
      entry.sentiment = partial.sentiment;
      entry.text = partial.text ?? entry.text;
      entry.timestamp = partial.timestamp ?? entry.timestamp;
      console.log(`[Aggregator] Stored sentiment for ID ${id}`);
      if (!entry.urgency) {
         console.log('[Aggregator] Waiting for matching urgency...');
      }
   }
   if (partial.urgency != null) {
      entry.urgency = partial.urgency;
      entry.text = partial.text ?? entry.text;
      entry.timestamp = partial.timestamp ?? entry.timestamp;
      console.log(`[Aggregator] Stored urgency for ID ${id}`);
      if (!entry.sentiment) {
         console.log('[Aggregator] Waiting for matching sentiment...');
      }
   }
   entry.lastUpdated = Date.now();
}

function tryMergeInsight(id: string): FullInsight | null {
   const entry = partialById.get(id);
   if (!entry?.sentiment || !entry?.urgency) return null;
   return {
      id,
      text: entry.text ?? '',
      timestamp: entry.timestamp ?? '',
      sentiment: entry.sentiment.sentiment,
      sentimentConfidence: entry.sentiment.confidence,
      urgency: entry.urgency.category,
      urgencyConfidence: entry.urgency.confidence,
   };
}

function handleBusinessLogic(full: FullInsight): void {
   if (full.sentiment === 'NEGATIVE' && full.urgency === 'Urgent') {
      console.log(`${RED_ANSI}ALERT: ANGRY CUSTOMER NEEDS HELP!${RESET_ANSI}`);
   }
   console.log(`[Aggregator] Full Insight: ${JSON.stringify(full)}`);
}

function cleanupEntry(id: string): void {
   partialById.delete(id);
}

function cleanupStaleEntries(): void {
   const now = Date.now();
   for (const [id, entry] of partialById.entries()) {
      const t = entry.lastUpdated ?? 0;
      if (now - t > STALE_ENTRY_MS) {
         partialById.delete(id);
         console.log(`[Aggregator] Removed stale partial entry for ID ${id}`);
      }
   }
}

// --- Main ---

async function main(): Promise<void> {
   const kafka = new Kafka({
      clientId: 'insight-aggregator',
      brokers: KAFKA_BROKERS,
   });
   const consumer = kafka.consumer({ groupId: CONSUMER_GROUP });

   await consumer.connect();
   await consumer.subscribe({
      topics: [SENTIMENT_TOPIC, URGENCY_TOPIC],
      fromBeginning: false,
   });

   console.log(
      `[Aggregator] Subscribed to ${SENTIMENT_TOPIC} and ${URGENCY_TOPIC}`
   );

   setInterval(cleanupStaleEntries, 60 * 1000); // every 1 min

   await consumer.run({
      eachMessage: async ({ topic, message }) => {
         const raw = message.value?.toString();
         if (!raw) return;
         try {
            const payload = safeJsonParse<unknown>(raw);
            if (payload == null) {
               console.error(
                  `[Aggregator] Invalid message from topic ${topic}, skipping`
               );
               return;
            }
            if (topic === SENTIMENT_TOPIC) {
               if (!isSentimentMessage(payload)) {
                  console.error(
                     `[Aggregator] Invalid message from topic ${topic}, skipping`
                  );
                  return;
               }
               const { id, text, sentiment, confidence, timestamp } = payload;
               updatePartialState(
                  id,
                  {
                     sentiment: { sentiment, confidence },
                     text,
                     timestamp,
                  },
                  topic
               );
               const full = tryMergeInsight(id);
               if (full) {
                  console.log(`[Aggregator] Full insight ready for ID ${id}`);
                  handleBusinessLogic(full);
                  cleanupEntry(id);
               }
               return;
            }
            if (topic === URGENCY_TOPIC) {
               if (!isUrgencyMessage(payload)) {
                  console.error(
                     `[Aggregator] Invalid message from topic ${topic}, skipping`
                  );
                  return;
               }
               const { id, text, category, confidence, timestamp } = payload;
               updatePartialState(
                  id,
                  {
                     urgency: { category, confidence },
                     text,
                     timestamp,
                  },
                  topic
               );
               const full = tryMergeInsight(id);
               if (full) {
                  console.log(`[Aggregator] Full insight ready for ID ${id}`);
                  handleBusinessLogic(full);
                  cleanupEntry(id);
               }
               return;
            }
         } catch (err) {
            console.error(
               '[Aggregator] Error processing message:',
               err instanceof Error ? err.message : err
            );
         }
      },
   });
}

main().catch((err) => {
   console.error(err);
   process.exit(1);
});
