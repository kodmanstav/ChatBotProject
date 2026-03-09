import { createKafkaClient, TOPICS } from './kafka/client';
import { runConsumer } from './kafka/consumer';
import { publishValidated } from './kafka/producer';
import { callOllamaWithFallback, callOpenAI } from './services/llm-client';
import { RAG_GENERATION_PROMPT } from './prompts/rag-generation.prompt';
import { ORCHESTRATION_SYNTHESIS_PROMPT } from './prompts/orchestration-synthesis.prompt';
import { alreadyProcessed, markProcessed } from './utils/idempotency';

const TOOL_INVOCATION_TOPIC = TOPICS.TOOL_INVOCATION_REQUESTS;
const CONVERSATION_EVENTS_TOPIC = TOPICS.CONVERSATION_EVENTS;
const CONSUMER_GROUP = 'llm-inference-worker-group';

const SUPPORTED_TOOLS = new Set([
   'generalChat',
   'ragGeneration',
   'orchestrationSynthesis',
]);

function isToolInvocationRequested(payload: unknown): payload is {
   eventType: 'ToolInvocationRequested';
   conversationId: string;
   timestamp: string;
   payload: { step: number; tool: string; parameters: Record<string, unknown> };
} {
   if (payload == null || typeof payload !== 'object') return false;
   const o = payload as Record<string, unknown>;
   if (o.eventType !== 'ToolInvocationRequested') return false;
   if (typeof o.conversationId !== 'string') return false;
   if (o.payload == null || typeof o.payload !== 'object') return false;
   const p = o.payload as Record<string, unknown>;
   return (
      typeof p.step === 'number' &&
      typeof p.tool === 'string' &&
      SUPPORTED_TOOLS.has(p.tool)
   );
}

function buildResultPayload(
   conversationId: string,
   timestamp: string,
   step: number,
   tool: string,
   success: boolean,
   result: unknown,
   error?: string
): object {
   const payload: Record<string, unknown> = {
      step,
      tool,
      success,
      result: result ?? {},
   };
   if (error) payload.error = error;
   return {
      eventType: 'ToolInvocationResulted',
      conversationId,
      timestamp,
      payload,
   };
}

async function runGeneralChat(
   parameters: Record<string, unknown>
): Promise<string> {
   const prompt =
      (parameters.prompt as string) ??
      (parameters.userInput as string) ??
      (parameters.message as string) ??
      (parameters.query as string) ??
      'Hello';
   const messages = [
      {
         role: 'system' as const,
         content: 'You are a helpful assistant. Answer concisely.',
      },
      { role: 'user' as const, content: String(prompt) },
   ];
   return callOllamaWithFallback(messages);
}

async function runRagGeneration(
   parameters: Record<string, unknown>
): Promise<string> {
   const context =
      (parameters.context as string) ??
      (parameters.retrieved_context as string) ??
      '';
   const question =
      (parameters.question as string) ?? (parameters.query as string) ?? '';
   const messages = [
      { role: 'system' as const, content: RAG_GENERATION_PROMPT },
      {
         role: 'user' as const,
         content: `Context:\n${context}\n\nQuestion: ${question}`,
      },
   ];
   return callOllamaWithFallback(messages);
}

async function runOrchestrationSynthesis(
   parameters: Record<string, unknown>
): Promise<string> {
   const planResults = parameters.planResults as
      | Record<string, unknown>
      | undefined;
   const text = planResults
      ? JSON.stringify(planResults, null, 2)
      : JSON.stringify(parameters, null, 2);
   const messages = [
      { role: 'system' as const, content: ORCHESTRATION_SYNTHESIS_PROMPT },
      {
         role: 'user' as const,
         content: `Intermediate results:\n${text}\n\nSynthesize a single final answer for the user.`,
      },
   ];
   return callOpenAI(messages);
}

async function main(): Promise<void> {
   const kafka = createKafkaClient('llm-inference-worker');
   const producer = kafka.producer();
   await producer.connect();

   await runConsumer(kafka, {
      topic: TOOL_INVOCATION_TOPIC,
      groupId: CONSUMER_GROUP,
      onMessage: async (payload) => {
         if (!isToolInvocationRequested(payload)) return;
         const { conversationId, timestamp, payload: pl } = payload;
         const step = pl.step;
         const tool = pl.tool;
         const parameters = (pl.parameters as Record<string, unknown>) ?? {};

         if (alreadyProcessed(conversationId, step, tool)) {
            console.log(
               `[LLM Worker] Skipping duplicate ${tool} for ${conversationId} step ${step}`
            );
            return;
         }
         console.log(
            `[LLM Worker] Processing ${tool} for conversation ${conversationId}`
         );

         let text: string;
         try {
            if (tool === 'generalChat') {
               text = await runGeneralChat(parameters);
            } else if (tool === 'ragGeneration') {
               text = await runRagGeneration(parameters);
            } else if (tool === 'orchestrationSynthesis') {
               text = await runOrchestrationSynthesis(parameters);
            } else {
               return;
            }
         } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[LLM Worker] Error:', msg);
            const out = buildResultPayload(
               conversationId,
               new Date().toISOString(),
               step,
               tool,
               false,
               {},
               msg
            );
            await publishValidated(producer, {
               topic: CONVERSATION_EVENTS_TOPIC,
               value: out,
            });
            markProcessed(conversationId, step, tool);
            return;
         }

         const result = { text };
         const out = buildResultPayload(
            conversationId,
            new Date().toISOString(),
            step,
            tool,
            true,
            result
         );
         const ok = await publishValidated(producer, {
            topic: CONVERSATION_EVENTS_TOPIC,
            value: out,
         });
         if (ok) {
            markProcessed(conversationId, step, tool);
            console.log('[LLM Worker] Published ToolInvocationResulted');
         }
      },
   });
}

main().catch((err) => {
   console.error('[LLM Worker] Fatal:', err);
   process.exit(1);
});
