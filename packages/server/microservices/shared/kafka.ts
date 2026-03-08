import { Kafka, logLevel, type EachMessagePayload } from 'kafkajs';
import { BROKERS } from './topics';

export function createKafka(clientId: string) {
   return new Kafka({
      clientId,
      brokers: [...BROKERS],
      logLevel: logLevel.NOTHING,
   });
}

export async function createProducer(clientId: string) {
   const kafka = createKafka(clientId);
   const producer = kafka.producer();
   await producer.connect();
   return producer;
}

export async function createConsumer(clientId: string, groupId: string) {
   const kafka = createKafka(clientId);
   const consumer = kafka.consumer({ groupId });
   await consumer.connect();
   return consumer;
}

export type JsonRecord = Record<string, unknown>;

export function safeJsonParse<T>(s: string): T | null {
   try {
      return JSON.parse(s) as T;
   } catch {
      return null;
   }
}

export async function sendJson(
   producer: Awaited<ReturnType<typeof createProducer>>,
   topic: string,
   key: string,
   value: JsonRecord
) {
   await producer.send({
      topic,
      messages: [{ key, value: JSON.stringify(value) }],
   });
}

export async function sendRaw(
   producer: Awaited<ReturnType<typeof createProducer>>,
   topic: string,
   key: string,
   value: string
) {
   await producer.send({
      topic,
      messages: [{ key, value }],
   });
}

export async function runConsumer(
   consumer: Awaited<ReturnType<typeof createConsumer>>,
   topic: string,
   onMessage: (payload: EachMessagePayload) => Promise<void>
) {
   await consumer.subscribe({ topic, fromBeginning: false });
   await consumer.run({
      eachMessage: async (payload) => {
         try {
            await onMessage(payload);
         } catch (err) {
            console.error(`[${topic}] handler error:`, err);
         }
      },
   });
}
