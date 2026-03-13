import { Kafka } from 'kafkajs';

const BROKERS = [process.env.KAFKA_BROKERS || 'localhost:9092'];

export const TOPICS = {
   USER_COMMANDS: 'user-commands',
   CONVERSATION_EVENTS: 'conversation-events',
   TOOL_INVOCATION_REQUESTS: 'tool-invocation-requests',
   DEAD_LETTER_QUEUE: 'dead-letter-queue',
} as const;

export function createKafkaClient(clientId: string): Kafka {
   return new Kafka({
      clientId,
      brokers: BROKERS,
   });
}
