import {
   createConsumer,
   createProducer,
   safeJsonParse,
   sendJson,
   runConsumer,
} from './shared/kafka';
import { TOPICS } from './shared/topics';

const ALLOWED_INTENTS = [
   'getWeather',
   'getExchangeRate',
   'calculateMath',
   'generalChat',
] as const;

type FunctionExecutionRequest = {
   intent: string;
   parameters: Record<string, unknown>;
   confidence: number;
};

type ParseErrorEvent = {
   sourceTopic: string;
   reason: string;
   raw: string;
   timestamp: string;
};

function stripJsonFences(raw: string): string {
   const s = raw.trim();
   const match = s.match(/^```(?:json)?\s*([\s\S]*?)```$/);
   return match?.[1] != null ? match[1].trim() : s;
}

function validateAndParse(raw: string): FunctionExecutionRequest | null {
   const cleaned = stripJsonFences(raw);
   const parsed = safeJsonParse<{
      intent?: unknown;
      parameters?: unknown;
      confidence?: unknown;
   }>(cleaned);

   if (!parsed || typeof parsed !== 'object') return null;

   const intent = parsed.intent;
   if (typeof intent !== 'string' || !intent.trim()) return null;
   if (!ALLOWED_INTENTS.includes(intent.trim() as (typeof ALLOWED_INTENTS)[number])) {
      return null;
   }

   const parameters = parsed.parameters;
   if (
      parameters === null ||
      typeof parameters !== 'object' ||
      Array.isArray(parameters)
   ) {
      return null;
   }

   let confidence = 0.5;
   if (typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)) {
      confidence = Math.max(0, Math.min(1, parsed.confidence));
   }

   return {
      intent: intent.trim(),
      parameters: parameters as Record<string, unknown>,
      confidence,
   };
}

const consumer = await createConsumer(
   'llm-parser-consumer',
   'llm-parser-llm-response-group'
);
const producer = await createProducer('llm-parser-producer');

console.log('[LLM-PARSER] starting, subscribing to', TOPICS.LLM_RESPONSE);

await consumer.subscribe({
   topic: TOPICS.LLM_RESPONSE,
   fromBeginning: false,
});

await consumer.run({
   eachMessage: async ({ message }) => {
      const userId = message.key?.toString() ?? '';
      const raw = message.value?.toString() ?? '';
      if (!userId) return;

      const parsed = validateAndParse(raw);

      if (parsed) {
         await sendJson(producer, TOPICS.FUNCTION_EXECUTION_REQUESTS, userId, {
            intent: parsed.intent,
            parameters: parsed.parameters,
            confidence: parsed.confidence,
         });
         console.log(
            '[LLM-PARSER] published to function_execution_requests',
            userId,
            parsed.intent
         );
      } else {
         const errorEvent: ParseErrorEvent = {
            sourceTopic: TOPICS.LLM_RESPONSE,
            reason: 'Invalid JSON or validation failed',
            raw: raw.slice(0, 2000),
            timestamp: new Date().toISOString(),
         };
         await sendJson(producer, TOPICS.ERROR_EVENTS, userId, errorEvent);
         console.log('[LLM-PARSER] published parse error to error_events', userId);
      }
   },
});
