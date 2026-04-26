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

const CONSUMER_START_MAX_RETRIES = Math.max(
   1,
   Number(process.env.KAFKA_CONSUMER_START_MAX_RETRIES) || 20
);
const CONSUMER_START_INITIAL_BACKOFF_MS = Math.max(
   100,
   Number(process.env.KAFKA_CONSUMER_START_INITIAL_BACKOFF_MS) || 1_000
);
const CONSUMER_START_MAX_BACKOFF_MS = Math.max(
   CONSUMER_START_INITIAL_BACKOFF_MS,
   Number(process.env.KAFKA_CONSUMER_START_MAX_BACKOFF_MS) || 10_000
);

function sleep(ms: number): Promise<void> {
   return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(err: unknown): string {
   if (err instanceof Error) return err.message;
   return String(err);
}

function shouldRetryConsumerStart(err: unknown): boolean {
   if (
      err &&
      typeof err === 'object' &&
      'retriable' in err &&
      (err as { retriable?: unknown }).retriable === true
   ) {
      return true;
   }

   const message = getErrorMessage(err).toLowerCase();
   return (
      message.includes('group coordinator is not available') ||
      message.includes('unknown topic or partition') ||
      message.includes('coordinator load in progress')
   );
}

async function connectSubscribeAndRun(
   consumer: ReturnType<Kafka['consumer']>,
   subscribe: () => Promise<void>,
   run: () => Promise<void>,
   groupId: string,
   topicsLabel: string
): Promise<void> {
   let attempt = 1;
   let backoffMs = CONSUMER_START_INITIAL_BACKOFF_MS;

   while (true) {
      try {
         await consumer.connect();
         await subscribe();
         await run();
         return;
      } catch (err) {
         const canRetry =
            attempt < CONSUMER_START_MAX_RETRIES &&
            shouldRetryConsumerStart(err);
         if (!canRetry) throw err;

         console.warn(
            `[Kafka consumer] Retry ${attempt}/${CONSUMER_START_MAX_RETRIES} for group=${groupId} topics=${topicsLabel}: ${getErrorMessage(
               err
            )}. Waiting ${backoffMs}ms before retry.`
         );

         try {
            await consumer.disconnect();
         } catch {
            // Ignore disconnect errors between retries.
         }
         await sleep(backoffMs);
         backoffMs = Math.min(backoffMs * 2, CONSUMER_START_MAX_BACKOFF_MS);
         attempt += 1;
      }
   }
}

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
   await connectSubscribeAndRun(
      consumer,
      async () =>
         consumer.subscribe({ topics: options.topics, fromBeginning: false }),
      async () =>
         consumer.run({
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
         }),
      options.groupId,
      options.topics.join(',')
   );
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
   await connectSubscribeAndRun(
      consumer,
      async () =>
         consumer.subscribe({ topic: options.topic, fromBeginning: false }),
      async () =>
         consumer.run({
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
         }),
      options.groupId,
      options.topic
   );
}
