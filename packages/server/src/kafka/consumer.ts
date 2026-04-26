import type { ConsumerConfig, Kafka } from 'kafkajs';
import { safeJsonParse } from '../utils/json';

export interface ConsumeOptions {
   topic: string;
   groupId: string;
   onMessage: (payload: unknown, raw: string) => void | Promise<void>;
   consumerConfig?: Omit<ConsumerConfig, 'groupId'>;
}

export interface ConsumeMultiOptions {
   topics: string[];
   groupId: string;
   onMessage: (
      payload: unknown,
      raw: string,
      topic: string
   ) => void | Promise<void>;
   consumerConfig?: Omit<ConsumerConfig, 'groupId'>;
}

const DEFAULT_CONSUMER_CONFIG: Omit<ConsumerConfig, 'groupId'> = {
   sessionTimeout: Number(process.env.KAFKA_SESSION_TIMEOUT_MS) || 60_000,
   heartbeatInterval: Number(process.env.KAFKA_HEARTBEAT_INTERVAL_MS) || 3_000,
   rebalanceTimeout: Number(process.env.KAFKA_REBALANCE_TIMEOUT_MS) || 60_000,
};

/**
 * Subscribe to multiple topics and run the consumer.
 */
export async function runConsumerMulti(
   kafka: Kafka,
   options: ConsumeMultiOptions
): Promise<void> {
   const consumer = kafka.consumer({
      groupId: options.groupId,
      ...DEFAULT_CONSUMER_CONFIG,
      ...(options.consumerConfig ?? {}),
   });
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
   const consumer = kafka.consumer({
      groupId: options.groupId,
      ...DEFAULT_CONSUMER_CONFIG,
      ...(options.consumerConfig ?? {}),
   });
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
