import { createKafkaClient, TOPICS } from './kafka/client';
import { runConsumer } from './kafka/consumer';
import { publishValidated } from './kafka/producer';
import { alreadyProcessed, markProcessed } from './utils/idempotency';

const TOOL_INVOCATION_TOPIC = TOPICS.TOOL_INVOCATION_REQUESTS;
const CONVERSATION_EVENTS_TOPIC = TOPICS.CONVERSATION_EVENTS;
const CONSUMER_GROUP = 'weather-worker-group';
const TOOL_NAME = 'getWeather';

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

function getWeather(location: string): { location: string; forecast: string } {
   const loc = (location || 'Unknown').trim() || 'Unknown';
   return {
      location: loc,
      forecast: `Sunny, 25°C (simulated for ${loc})`,
   };
}

async function main(): Promise<void> {
   const kafka = createKafkaClient('weather-worker');
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
         const location =
            (parameters.location as string) ??
            (parameters.city as string) ??
            'Tel Aviv';

         if (alreadyProcessed(conversationId, step, TOOL_NAME)) {
            console.log(
               `[Weather Worker] Skipping duplicate for ${conversationId} step ${step}`
            );
            return;
         }
         console.log(
            `[Weather Worker] Processing getWeather for ${conversationId}`
         );

         const result = getWeather(location);
         const out = {
            eventType: 'ToolInvocationResulted',
            conversationId,
            timestamp: new Date().toISOString(),
            payload: {
               step,
               tool: TOOL_NAME,
               success: true,
               result,
            },
         };
         const ok = await publishValidated(producer, {
            topic: CONVERSATION_EVENTS_TOPIC,
            value: out,
         });
         if (ok) {
            markProcessed(conversationId, step, TOOL_NAME);
            console.log('[Weather Worker] Published ToolInvocationResulted');
         }
      },
   });
}

main().catch((err) => {
   console.error('[Weather Worker] Fatal:', err);
   process.exit(1);
});
