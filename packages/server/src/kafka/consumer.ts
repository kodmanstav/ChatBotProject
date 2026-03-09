import type { Kafka } from 'kafkajs';
import { safeJsonParse } from '../utils/json';

export interface ConsumeOptions {
   topic: string;
   groupId: string;
   onMessage: (payload: unknown, raw: string) => void | Promise<void>;
}

export interface ConsumeMultiOptions {
   topics: string[];
   groupId: string;
   onMessage: (
      payload: unknown,
      raw: string,
      topic: string
   ) => void | Promise<void>;
}

/**
 * Subscribe to multiple topics and run the consumer.
 */
export async function runConsumerMulti(
   kafka: Kafka,
   options: ConsumeMultiOptions
): Promise<void> {
   const consumer = kafka.consumer({ groupId: options.groupId });
   await consumer.connect();
   await consumer.subscribe({ topics: options.topics, fromBeginning: false });
   await consumer.run({
      eachMessage: async ({ topic, message }) => {
         const raw = message.value?.toString();
         if (!raw) return;
         const payload = safeJsonParse<unknown>(raw);
         if (payload == null) return;
         try {
            await Promise.resolve(options.onMessage(payload, raw, topic));
         } catch (err) {
            console.error('[Kafka consumer] Handler error:', err);
         }
      },
   });
}

/**
 * Subscribe to a topic and run the consumer. Parses JSON and invokes onMessage.
 * Malformed messages are skipped (logged by caller if desired).
 */
export async function runConsumer(
   kafka: Kafka,
   options: ConsumeOptions
): Promise<void> {
   const consumer = kafka.consumer({ groupId: options.groupId });
   await consumer.connect();
   await consumer.subscribe({ topic: options.topic, fromBeginning: false });
   await consumer.run({
      eachMessage: async ({ message }) => {
         const raw = message.value?.toString();
         if (!raw) return;
         const payload = safeJsonParse<unknown>(raw);
         if (payload == null) return;
         try {
            await Promise.resolve(options.onMessage(payload, raw));
         } catch (err) {
            console.error('[Kafka consumer] Handler error:', err);
         }
      },
   });
}
