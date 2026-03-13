import dotenv from 'dotenv';
import path from 'path';

const rootDir =
   typeof (import.meta as { dir?: string }).dir === 'string'
      ? path.join((import.meta as { dir: string }).dir, '..')
      : path.dirname(new URL(import.meta.url).pathname);
dotenv.config({ path: path.join(rootDir, '.env') });

import { Kafka } from 'kafkajs';
import { routeText } from './services/router.service';
import {
   analyzeReview,
   shouldSelfCorrect,
   correctAnalysis,
} from './services/review-analyzer.service';
import type { RawReviewMessage, ProcessedInsight } from './types';
import { safeJsonParse } from './utils/json';

const RAW_TOPIC = 'raw-reviews-topic';
const PROCESSED_TOPIC = 'processed-insights-topic';
const BROKERS = [process.env.KAFKA_BROKERS || 'localhost:9092'];

const kafka = new Kafka({
   clientId: 'review-processor',
   brokers: BROKERS,
});

const consumer = kafka.consumer({ groupId: 'review-processor-group' });
const producer = kafka.producer();

async function publishProcessedInsight(
   insight: ProcessedInsight
): Promise<void> {
   await producer.send({
      topic: PROCESSED_TOPIC,
      messages: [
         {
            key: insight.reviewId,
            value: JSON.stringify(insight),
         },
      ],
   });
   console.log(`[PROCESSOR] Published insight for review ${insight.reviewId}`);
}

async function processMessage(rawValue: string): Promise<void> {
   const msg = safeJsonParse<RawReviewMessage>(rawValue);
   if (!msg?.reviewId || typeof msg.text !== 'string' || !msg.timestamp) {
      console.error('[PROCESSOR] Invalid message format, skip');
      return;
   }

   const text = msg.text.trim();
   if (!text) {
      console.log('[PROCESSOR] Empty text, skip');
      return;
   }

   const { intent } = await routeText(text);
   if (intent === 'generalChat') {
      console.log(`[PROCESSOR] Skipped (generalChat): ${msg.reviewId}`);
      return;
   }

   let analysis = await analyzeReview(text);
   if (!analysis) {
      console.error(`[PROCESSOR] LLM analysis failed for ${msg.reviewId}`);
      return;
   }

   if (shouldSelfCorrect(analysis)) {
      console.log(
         `[PROCESSOR] Self-correcting ${msg.reviewId} (score/sentiment mismatch)`
      );
      analysis = await correctAnalysis(text, analysis);
   }

   const insight: ProcessedInsight = {
      reviewId: msg.reviewId,
      timestamp: msg.timestamp,
      summary: analysis.summary,
      overall_sentiment: analysis.overall_sentiment,
      score: analysis.score,
      aspects: analysis.aspects,
   };

   await publishProcessedInsight(insight);
}

async function main() {
   await producer.connect();
   await consumer.connect();
   await consumer.subscribe({ topic: RAW_TOPIC, fromBeginning: false });

   console.log(
      `[PROCESSOR] Subscribed to ${RAW_TOPIC}, producing to ${PROCESSED_TOPIC}`
   );

   await consumer.run({
      eachMessage: async ({ topic, message }) => {
         const value = message.value?.toString();
         if (!value) return;
         try {
            await processMessage(value);
         } catch (err) {
            console.error(`[PROCESSOR] Error:`, (err as Error)?.message ?? err);
         }
      },
   });
}

main().catch((err) => {
   console.error(err);
   process.exit(1);
});
