import dotenv from 'dotenv';
import path from 'path';

const rootDir =
   typeof (import.meta as { dir?: string }).dir === 'string'
      ? path.join((import.meta as { dir: string }).dir, '..')
      : path.dirname(new URL(import.meta.url).pathname);
dotenv.config({ path: path.join(rootDir, '.env') });

import { Kafka } from 'kafkajs';
import type { AspectInsight, ProcessedInsight } from './types';
import { safeJsonParse } from './utils/json';

const PROCESSED_TOPIC = 'processed-insights-topic';
const BROKERS = ['localhost:9092'];
const CONSUMER_GROUP_ID = 'analytics-consumer-group';

const SENTIMENTS = ['Positive', 'Negative', 'Neutral'] as const;

function isSentiment(s: unknown): s is (typeof SENTIMENTS)[number] {
   return typeof s === 'string' && SENTIMENTS.includes(s as (typeof SENTIMENTS)[number]);
}

function isAspectInsight(obj: unknown): obj is AspectInsight {
   if (obj == null || typeof obj !== 'object') return false;
   const o = obj as Record<string, unknown>;
   return (
      typeof o.name === 'string' &&
      typeof o.mention === 'string' &&
      isSentiment(o.sentiment)
   );
}

/**
 * Validates parsed message and returns ProcessedInsight or null.
 */
function validateProcessedInsight(obj: unknown): ProcessedInsight | null {
   if (obj == null || typeof obj !== 'object') return null;
   const o = obj as Record<string, unknown>;

   if (typeof o.reviewId !== 'string') return null;
   if (typeof o.timestamp !== 'string') return null;
   if (typeof o.summary !== 'string') return null;
   if (!isSentiment(o.overall_sentiment)) return null;
   if (typeof o.score !== 'number' || Number.isNaN(o.score)) return null;
   if (!Array.isArray(o.aspects)) return null;

   const aspects: AspectInsight[] = [];
   for (const a of o.aspects) {
      if (!isAspectInsight(a)) return null;
      aspects.push(a);
   }

   return {
      reviewId: o.reviewId,
      timestamp: o.timestamp,
      summary: o.summary,
      overall_sentiment: o.overall_sentiment,
      score: o.score,
      aspects,
   };
}

/**
 * Format aspects for display: Name (Sentiment - "mention"), ...
 */
function formatAspects(aspects: AspectInsight[]): string {
   if (aspects.length === 0) return '(none)';
   return aspects
      .map((a) => `${a.name} (${a.sentiment} - "${a.mention}")`)
      .join(', ');
}

/**
 * Compute new running average after adding one score.
 */
function updateRunningAverage(
   currentAvg: number,
   count: number,
   newScore: number
): number {
   if (count <= 0) return newScore;
   return (currentAvg * count + newScore) / (count + 1);
}

// Running state for restaurant rating
let runningAverage = 0;
let reviewCount = 0;

async function main() {
   const kafka = new Kafka({
      clientId: 'analytics-consumer',
      brokers: BROKERS,
   });

   const consumer = kafka.consumer({ groupId: CONSUMER_GROUP_ID });

   const shutdown = async () => {
      try {
         await consumer.disconnect();
         console.log('[ANALYTICS] Disconnected.');
      } finally {
         process.exit(0);
      }
   };

   process.on('SIGINT', shutdown);
   process.on('SIGTERM', shutdown);

   try {
      await consumer.connect();
      await consumer.subscribe({
         topic: PROCESSED_TOPIC,
         fromBeginning: false,
      });
      console.log(`[ANALYTICS] Subscribed to ${PROCESSED_TOPIC}. Waiting for messages...\n`);
   } catch (err) {
      console.error('[ANALYTICS] Kafka connection failed:', (err as Error)?.message ?? err);
      process.exit(1);
   }

   await consumer.run({
      eachMessage: async ({ topic, message }) => {
         const value = message.value?.toString();
         if (!value) return;

         try {
            const parsed = safeJsonParse<unknown>(value);
            if (parsed === null) {
               console.error('[ANALYTICS] Invalid JSON, skipping message.');
               return;
            }

            const insight = validateProcessedInsight(parsed);
            if (!insight) {
               console.error('[ANALYTICS] Invalid or missing fields, skipping message.');
               return;
            }

            console.log(
               `New Insight Received! ID: ${insight.reviewId} | Score: ${insight.score}/10 | Sentiment: ${insight.overall_sentiment} | Summary: ${insight.summary}`
            );
            console.log(`Aspects: ${formatAspects(insight.aspects)}`);

            reviewCount += 1;
            runningAverage = updateRunningAverage(
               runningAverage,
               reviewCount - 1,
               insight.score
            );
            const displayRating = Math.round(runningAverage * 10) / 10;
            console.log(`Current Restaurant Rating: ${displayRating}/10`);
            console.log('---');
         } catch (err) {
            console.error('[ANALYTICS] Error processing message:', (err as Error)?.message ?? err);
         }
      },
   });
}

main().catch((err) => {
   console.error(err);
   process.exit(1);
});
