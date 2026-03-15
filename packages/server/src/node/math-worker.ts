import { createKafkaClient, TOPICS } from '../kafka/client';
import { runConsumer } from '../kafka/consumer';
import { publishValidated } from '../kafka/producer';
import { alreadyProcessed, markProcessed } from '../utils/idempotency';

const TOOL_INVOCATION_TOPIC = TOPICS.TOOL_INVOCATION_REQUESTS;
const CONVERSATION_EVENTS_TOPIC = TOPICS.CONVERSATION_EVENTS;
const CONSUMER_GROUP = 'math-worker-group';
const TOOL_NAME = 'calculateMath';

function isToolRequest(payload: unknown): payload is {
   eventType: 'ToolInvocationRequested';
   conversationId: string;
   timestamp: string;
   payload: { step: number; tool: string; parameters: Record<string, unknown> };
} {
   if (payload == null || typeof payload !== 'object') return false;
   const o = payload as Record<string, unknown>;
   if (o.eventType !== 'ToolInvocationRequested') return false;
   const p = o.payload;
   if (p == null || typeof p !== 'object') return false;
   return (p as Record<string, unknown>).tool === TOOL_NAME;
}

function calculate(expression: string): number | null {
   const trimmed = String(expression).replace(/\s+/g, '').trim();
   if (!/^[\d\s+\-*/().]+$/.test(trimmed)) return null;
   try {
      return Function(`"use strict"; return (${trimmed})`)() as number;
   } catch {
      return null;
   }
}

async function main(): Promise<void> {
   const kafka = createKafkaClient('math-worker');
   const producer = kafka.producer();
   await producer.connect();

   await runConsumer(kafka, {
      topic: TOOL_INVOCATION_TOPIC,
      groupId: CONSUMER_GROUP,
      onMessage: async (payload) => {
         if (!isToolRequest(payload)) return;
         const { conversationId, timestamp, payload: pl } = payload;
         const step = pl.step;
         const parameters = (pl.parameters as Record<string, unknown>) ?? {};
         const expression =
            (parameters.expression as string) ??
            (parameters.expr as string) ??
            '0';

         if (alreadyProcessed(conversationId, step, TOOL_NAME)) {
            console.log(
               `[Math Worker] Skipping duplicate for ${conversationId} step ${step}`
            );
            return;
         }
         console.log(
            `[Math Worker] Processing calculateMath for ${conversationId}`
         );

         const value = calculate(expression);
         const success = value !== null;
         const result = success
            ? { expression, value }
            : { expression, error: 'Invalid or unsupported expression' };
         const out = {
            eventType: 'ToolInvocationResulted',
            conversationId,
            timestamp: new Date().toISOString(),
            payload: {
               step,
               tool: TOOL_NAME,
               success,
               result,
            },
         };
         const ok = await publishValidated(producer, {
            topic: CONVERSATION_EVENTS_TOPIC,
            value: out,
         });
         if (ok) {
            markProcessed(conversationId, step, TOOL_NAME);
            console.log('[Math Worker] Published ToolInvocationResulted');
         }
      },
   });
}

main().catch((err) => {
   console.error('[Math Worker] Fatal:', err);
   process.exit(1);
});
