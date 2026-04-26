import { logLevel } from 'kafkajs';
import type { Producer } from 'kafkajs';
import { randomUUID } from 'node:crypto';
import { createKafkaClient, TOPICS } from '../src/kafka/client';
import { runConsumer } from '../src/kafka/consumer';
import { publishValidated } from '../src/kafka/producer';
import type {
   FinalAnswerSynthesizedEvent,
   UserQueryReceivedEvent,
} from '../src/types/events';

const RESPONSE_TIMEOUT_MS = Number(
   process.env.CHAT_RESPONSE_TIMEOUT_MS ?? 120000
);

type PendingRequest = {
   resolve: (value: { message: string; latencyMs: number | null }) => void;
   timeoutId: ReturnType<typeof setTimeout>;
   userQueryTimestamp: string;
};

class ChatService {
   private kafka = createKafkaClient('http-chat-bridge', {
      logLevel: logLevel.NOTHING,
   });

   private producer: Producer | null = null;
   private isConsumerRunning = false;
   private pending = new Map<string, PendingRequest>();

   private isFinalAnswerEvent(
      payload: unknown
   ): payload is FinalAnswerSynthesizedEvent {
      if (payload == null || typeof payload !== 'object') return false;
      const event = payload as Record<string, unknown>;
      if (event.eventType !== 'FinalAnswerSynthesized') return false;
      if (typeof event.conversationId !== 'string') return false;
      if (typeof event.timestamp !== 'string') return false;
      if (event.payload == null || typeof event.payload !== 'object')
         return false;
      const nested = event.payload as Record<string, unknown>;
      return typeof nested.finalAnswer === 'string';
   }

   private async ensureInitialized(): Promise<void> {
      if (this.producer == null) {
         this.producer = this.kafka.producer();
         await this.producer.connect();
      }

      if (this.isConsumerRunning) return;
      this.isConsumerRunning = true;

      runConsumer(this.kafka, {
         topic: TOPICS.CONVERSATION_EVENTS,
         groupId: 'http-chat-bridge-events',
         onMessage: (payload) => {
            if (!this.isFinalAnswerEvent(payload)) return;

            const pendingRequest = this.pending.get(payload.conversationId);
            if (!pendingRequest) return;

            clearTimeout(pendingRequest.timeoutId);
            this.pending.delete(payload.conversationId);
            const t0 = Date.parse(pendingRequest.userQueryTimestamp);
            const t1 = Date.parse(payload.timestamp);
            const latencyMs =
               Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0
                  ? t1 - t0
                  : null;
            pendingRequest.resolve({
               message: payload.payload.finalAnswer,
               latencyMs,
            });
         },
      }).catch((error) => {
         console.error('[chat.service] consumer crashed:', error);
         this.isConsumerRunning = false;
      });
   }

   async sendMessage(
      prompt: string,
      conversationId: string
   ): Promise<{ message: string; latencyMs: number | null }> {
      await this.ensureInitialized();

      if (this.producer == null) {
         throw new Error('Producer is not initialized');
      }

      if (this.pending.has(conversationId)) {
         throw new Error(
            `Conversation ${conversationId} already has a pending request`
         );
      }

      const timestamp = new Date().toISOString();
      const command: UserQueryReceivedEvent = {
         eventType: 'UserQueryReceived',
         conversationId,
         timestamp,
         payload: { userInput: prompt },
      };

      const answerPromise = new Promise<{
         message: string;
         latencyMs: number | null;
      }>((resolve, reject) => {
         const timeoutId = setTimeout(() => {
            this.pending.delete(conversationId);
            reject(
               new Error(
                  `Timed out waiting for final answer (${RESPONSE_TIMEOUT_MS}ms)`
               )
            );
         }, RESPONSE_TIMEOUT_MS);

         this.pending.set(conversationId, {
            resolve,
            timeoutId,
            userQueryTimestamp: timestamp,
         });
      });

      const published = await publishValidated(this.producer, {
         topic: TOPICS.USER_COMMANDS,
         value: command,
         sendToDlqOnValidationFailure: true,
      });

      if (!published) {
         const pendingRequest = this.pending.get(conversationId);
         if (pendingRequest) {
            clearTimeout(pendingRequest.timeoutId);
            this.pending.delete(conversationId);
         }
         throw new Error(
            `Failed to publish UserQueryReceived (${randomUUID()})`
         );
      }

      return answerPromise;
   }
}

export const chatService = new ChatService();
