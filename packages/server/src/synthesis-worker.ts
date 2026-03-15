import { createKafkaClient, TOPICS } from './kafka/client';
import { runConsumer } from './kafka/consumer';
import { publishValidated } from './kafka/producer';
import { callOpenAI } from './services/llm-client';
import { ORCHESTRATION_SYNTHESIS_PROMPT } from './prompts/orchestration-synthesis.prompt';
import { logExecution } from './utils/logger';

const USER_COMMANDS_TOPIC = TOPICS.USER_COMMANDS;
const CONVERSATION_EVENTS_TOPIC = TOPICS.CONVERSATION_EVENTS;
const CONSUMER_GROUP = 'synthesis-worker-group';

const synthesizedConversations = new Set<string>();

function buildFinalAnswerFromPlanResults(
   planResults: Record<string, unknown>
): string {
   const first = planResults?.['1'] as Record<string, unknown> | undefined;
   if (!first || typeof first !== 'object') {
      return 'Sorry, I could not generate an answer.';
   }

   const text = (first as Record<string, unknown>).text;
   if (typeof text === 'string' && text.trim()) {
      return text.trim();
   }

   const expression = (first as Record<string, unknown>).expression;
   const value = (first as Record<string, unknown>).value;
   if (typeof expression === 'string' && typeof value !== 'undefined') {
      return `The result of ${expression} is ${value}.`;
   }

   if (typeof value !== 'undefined') {
      return String(value);
   }

   return 'Sorry, I could not generate an answer.';
}

function isSynthesizeRequest(payload: unknown): payload is {
   eventType: 'SynthesizeFinalAnswerRequested';
   conversationId: string;
   timestamp: string;
   payload: { planResults: Record<string, unknown> };
} {
   if (payload == null || typeof payload !== 'object') return false;
   const o = payload as Record<string, unknown>;
   if (o.eventType !== 'SynthesizeFinalAnswerRequested') return false;
   if (typeof o.conversationId !== 'string') return false;
   if (o.payload == null || typeof o.payload !== 'object') return false;
   const p = o.payload as Record<string, unknown>;
   return p.planResults != null && typeof p.planResults === 'object';
}

async function main(): Promise<void> {
   const kafka = createKafkaClient('synthesis-worker');
   const producer = kafka.producer();
   await producer.connect();

   await runConsumer(kafka, {
      topic: USER_COMMANDS_TOPIC,
      groupId: CONSUMER_GROUP,
      onMessage: async (payload) => {
         if (!isSynthesizeRequest(payload)) return;
         const { conversationId, timestamp, payload: pl } = payload;
         const planResults = pl.planResults;

         if (synthesizedConversations.has(conversationId)) {
            console.log(
               `[Synthesis Worker] Skipping duplicate synthesis for ${conversationId}`
            );
            return;
         }
         console.log(
            `[Synthesis Worker] Received synthesis request for ${conversationId}`
         );
         console.log(
            '[Synthesis Worker] incoming planResults:',
            JSON.stringify(planResults, null, 2)
         );
         logExecution(
            'synthesis-worker',
            conversationId,
            'SynthesisRequested',
            { keys: Object.keys(planResults ?? {}) }
         );

         let finalAnswer: string;
         try {
            const text = JSON.stringify(planResults, null, 2);
            console.log('[Synthesis] Using OpenAI');
            const openAiAnswer = await callOpenAI([
               { role: 'system', content: ORCHESTRATION_SYNTHESIS_PROMPT },
               {
                  role: 'user',
                  content: `Intermediate results:\n${text}\n\nSynthesize a single final answer for the user.`,
               },
            ]);
            if (openAiAnswer && openAiAnswer.trim()) {
               finalAnswer = openAiAnswer.trim();
            } else {
               finalAnswer = buildFinalAnswerFromPlanResults(planResults);
            }
         } catch (err) {
            console.error('[Synthesis Worker] OpenAI error:', err);
            finalAnswer = buildFinalAnswerFromPlanResults(planResults);
         }

         console.log('[Synthesis Worker] finalAnswer:', finalAnswer);
         logExecution(
            'synthesis-worker',
            conversationId,
            'FinalAnswerPrepared',
            { length: finalAnswer.length }
         );

         const out = {
            eventType: 'FinalAnswerSynthesized',
            conversationId,
            timestamp: new Date().toISOString(),
            payload: { finalAnswer },
         };
         const ok = await publishValidated(producer, {
            topic: CONVERSATION_EVENTS_TOPIC,
            value: out,
            sendToDlqOnValidationFailure: true,
         });
         if (ok) {
            synthesizedConversations.add(conversationId);
            console.log('[Synthesis Worker] Published FinalAnswerSynthesized');
         }
      },
   });
}

main().catch((err) => {
   console.error('[Synthesis Worker] Fatal:', err);
   process.exit(1);
});
