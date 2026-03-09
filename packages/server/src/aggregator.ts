import { createKafkaClient, TOPICS } from './kafka/client';
import { runConsumerMulti } from './kafka/consumer';
import { publishValidated } from './kafka/producer';
import type { SynthesizeFinalAnswerRequestedEvent } from './types/events';

const CONVERSATION_EVENTS_TOPIC = TOPICS.CONVERSATION_EVENTS;
const USER_COMMANDS_TOPIC = TOPICS.USER_COMMANDS;
const CONSUMER_GROUP = 'aggregator-group';

const resultsByConversation = new Map<string, Record<string, unknown>>();

function isToolInvocationResulted(payload: unknown): payload is {
   eventType: 'ToolInvocationResulted';
   conversationId: string;
   payload: { step?: number; tool: string; success: boolean; result: unknown };
} {
   if (payload == null || typeof payload !== 'object') return false;
   const o = payload as Record<string, unknown>;
   if (o.eventType !== 'ToolInvocationResulted') return false;
   if (typeof o.conversationId !== 'string') return false;
   if (o.payload == null || typeof o.payload !== 'object') return false;
   const p = o.payload as Record<string, unknown>;
   return typeof p.tool === 'string' && typeof p.success === 'boolean';
}

function isPlanCompleted(payload: unknown): payload is {
   eventType: 'PlanCompleted';
   conversationId: string;
   timestamp: string;
   payload: { completedSteps: number; results: Record<string, unknown> };
} {
   if (payload == null || typeof payload !== 'object') return false;
   const o = payload as Record<string, unknown>;
   if (o.eventType !== 'PlanCompleted') return false;
   if (typeof o.conversationId !== 'string') return false;
   if (o.payload == null || typeof o.payload !== 'object') return false;
   const p = o.payload as Record<string, unknown>;
   return (
      typeof p.completedSteps === 'number' &&
      p.results != null &&
      typeof p.results === 'object'
   );
}

async function main(): Promise<void> {
   const kafka = createKafkaClient('aggregator');
   const producer = kafka.producer();
   await producer.connect();

   await runConsumerMulti(kafka, {
      topics: [CONVERSATION_EVENTS_TOPIC],
      groupId: CONSUMER_GROUP,
      onMessage: async (payload, _raw, topic) => {
         if (topic !== CONVERSATION_EVENTS_TOPIC) return;

         if (isToolInvocationResulted(payload)) {
            const { conversationId, payload: pl } = payload;
            const step =
               pl.step ??
               Object.keys(resultsByConversation.get(conversationId) ?? {})
                  .length + 1;
            let map = resultsByConversation.get(conversationId);
            if (!map) {
               map = {};
               resultsByConversation.set(conversationId, map);
            }
            map[String(step)] = pl.result;
            console.log(`[Aggregator] Stored result for step ${step}`);
            return;
         }

         if (isPlanCompleted(payload)) {
            const { conversationId, timestamp, payload: pl } = payload;
            console.log(
               `[Aggregator] PlanCompleted received for ${conversationId}`
            );
            const planResults = pl.results as Record<string, unknown>;
            const stored = resultsByConversation.get(conversationId);
            const merged = stored ? { ...stored, ...planResults } : planResults;
            resultsByConversation.delete(conversationId);

            const cmd: SynthesizeFinalAnswerRequestedEvent = {
               eventType: 'SynthesizeFinalAnswerRequested',
               conversationId,
               timestamp: new Date().toISOString(),
               payload: { planResults: merged },
            };
            const ok = await publishValidated(producer, {
               topic: USER_COMMANDS_TOPIC,
               value: cmd,
               sendToDlqOnValidationFailure: true,
            });
            if (ok) {
               console.log(
                  '[Aggregator] Published SynthesizeFinalAnswerRequested'
               );
            }
         }
      },
   });
}

main().catch((err) => {
   console.error('[Aggregator] Fatal:', err);
   process.exit(1);
});
