import { createKafkaClient, TOPICS } from './kafka/client';
import { runConsumer } from './kafka/consumer';
import { publishValidated } from './kafka/producer';
import { alreadyProcessed, markProcessed } from './utils/idempotency';

const TOOL_INVOCATION_TOPIC = TOPICS.TOOL_INVOCATION_REQUESTS;
const CONVERSATION_EVENTS_TOPIC = TOPICS.CONVERSATION_EVENTS;
const CONSUMER_GROUP = 'exchange-rate-worker-group';
const TOOL_NAME = 'getExchangeRate';

const RATES: Record<string, Record<string, number>> = {
   USD: { ILS: 3.7, EUR: 0.92, GBP: 0.79 },
   EUR: { USD: 1.09, ILS: 4.02, GBP: 0.86 },
   ILS: { USD: 0.27, EUR: 0.25, GBP: 0.21 },
   GBP: { USD: 1.27, EUR: 1.16, ILS: 4.65 },
};

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

function getRate(from: string, to: string): number | null {
   const u = (from || '').toUpperCase().trim();
   const v = (to || '').toUpperCase().trim();
   if (!u || !v) return null;
   return RATES[u]?.[v] ?? null;
}

async function main(): Promise<void> {
   const kafka = createKafkaClient('exchange-rate-worker');
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
         const from =
            (parameters.from as string) ??
            (parameters.source as string) ??
            'USD';
         const to =
            (parameters.to as string) ?? (parameters.target as string) ?? 'ILS';

         if (alreadyProcessed(conversationId, step, TOOL_NAME)) {
            console.log(
               `[Exchange Worker] Skipping duplicate for ${conversationId} step ${step}`
            );
            return;
         }
         console.log(
            `[Exchange Worker] Processing getExchangeRate for ${conversationId}`
         );

         const rate = getRate(from, to);
         const success = rate !== null;
         const result = success
            ? { from: from.toUpperCase(), to: to.toUpperCase(), rate }
            : { from, to, error: 'Unsupported currency pair' };
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
            console.log('[Exchange Worker] Published ToolInvocationResulted');
         }
      },
   });
}

main().catch((err) => {
   console.error('[Exchange Worker] Fatal:', err);
   process.exit(1);
});
