import dotenv from 'dotenv';
import path from 'path';

const envPath = path.join(import.meta.dir, '..', '.env');
const envResult = dotenv.config({ path: envPath });

console.log('[ROUTER] env path =', envPath);
console.log('[ROUTER] dotenv error =', envResult.error);
console.log('[ROUTER] OPENAI key exists =', !!process.env.OPENAI_API_KEY);
console.log('[ROUTER] OPENAI key prefix =', process.env.OPENAI_API_KEY?.slice(0, 10));

import OpenAI from 'openai';
import {
   createConsumer,
   createProducer,
   safeJsonParse,
   sendJson,
   runConsumer,
} from './shared/kafka';
import { TOPICS } from './shared/topics';
import { ROUTER_SYSTEM_PROMPT } from '../prompts';

type HistoryItem = { role: 'user' | 'assistant'; content: string; ts: number };
type UserInputEvent = { userInput: string };
type HistoryUpdate = { history: HistoryItem[] };
type UserControlEvent = { command: 'reset' };

const ALLOWED_INTENTS = [
   'getWeather',
   'getExchangeRate',
   'calculateMath',
   'generalChat',
] as const;
type RouterIntent = (typeof ALLOWED_INTENTS)[number];

type RouterDecision = {
   intent: string;
   parameters: Record<string, unknown>;
   confidence: number;
};

const producer = await createProducer('router-producer');

const inputConsumer = await createConsumer(
   'router-consumer-input',
   'router-user-input-group'
);
const historyConsumer = await createConsumer(
   'router-consumer-history',
   'router-history-update-group'
);

const historyCache = new Map<string, HistoryItem[]>();

const apiKey = process.env.OPENAI_API_KEY;
const openai = apiKey ? new OpenAI({ apiKey }) : null;

function stripJsonFences(raw: string): string {
   const s = raw.trim();
   const match = s.match(/^```(?:json)?\s*([\s\S]*?)```$/);
   return match?.[1] != null ? match[1].trim() : s;
}

function parseRouterResponse(raw: string): RouterDecision | null {
   const cleaned = stripJsonFences(raw);
   const parsed = safeJsonParse<{ intent?: string; parameters?: unknown; confidence?: unknown }>(
      cleaned
   );
   if (!parsed || typeof parsed !== 'object') return null;
   const intent =
      typeof parsed.intent === 'string' && ALLOWED_INTENTS.includes(parsed.intent as RouterIntent)
         ? (parsed.intent as RouterIntent)
         : 'generalChat';
   const parameters =
      parsed.parameters && typeof parsed.parameters === 'object' && !Array.isArray(parsed.parameters)
         ? (parsed.parameters as Record<string, unknown>)
         : {};
   let confidence = 0.5;
   if (typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)) {
      confidence = Math.max(0, Math.min(1, parsed.confidence));
   }
   return { intent, parameters, confidence };
}

function normalizeDecision(decision: RouterDecision, userInput: string): RouterDecision {
   const { intent, parameters, confidence } = decision;
   const params = { ...parameters };

   if (intent === 'getWeather') {
      if (typeof params.city !== 'string') params.city = params.city ?? null;
   }
   if (intent === 'getExchangeRate') {
      if (typeof params.from !== 'string') params.from = params.from ?? 'USD';
      if (typeof params.to !== 'string') params.to = params.to ?? 'ILS';
   }
   if (intent === 'calculateMath') {
      if (typeof params.expression !== 'string') params.expression = params.expression ?? null;
      if (typeof params.textProblem !== 'string') params.textProblem = params.textProblem ?? null;
   }

   return { intent, parameters: params, confidence };
}

async function classifyWithLLM(userInput: string): Promise<RouterDecision> {
   const fallback: RouterDecision = {
      intent: 'generalChat',
      parameters: {},
      confidence: 0.3,
   };

   if (!openai) {
      console.log('[ROUTER] no OPENAI_API_KEY, fallback to generalChat');
      return fallback;
   }

   try {
      const resp = await openai.chat.completions.create({
         model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
         messages: [
            { role: 'system', content: ROUTER_SYSTEM_PROMPT },
            { role: 'user', content: userInput },
         ],
         temperature: 0.2,
         max_tokens: 300,
      });

      const content = resp.choices?.[0]?.message?.content?.trim();
      if (!content) return fallback;

      const decision = parseRouterResponse(content);
      if (!decision) {
         console.log('[ROUTER] failed to parse LLM response, fallback to generalChat');
         return fallback;
      }

      return normalizeDecision(decision, userInput);
   } catch (err) {
      console.error('[ROUTER] LLM error:', (err as Error)?.message ?? err);
      return fallback;
   }
}

console.log('[ROUTER] starting...');
console.log(
   `[ROUTER] subscribing to: ${TOPICS.APPROVED_USER_INPUT}, ${TOPICS.HISTORY_UPDATE}`
);

await historyConsumer.subscribe({
   topic: TOPICS.HISTORY_UPDATE,
   fromBeginning: false,
});
await inputConsumer.subscribe({
   topic: TOPICS.APPROVED_USER_INPUT,
   fromBeginning: false,
});

await Promise.all([
   historyConsumer.run({
      eachMessage: async ({ message }) => {
         const userId = message.key?.toString() ?? '';
         const raw = message.value?.toString() ?? '';
         if (!userId || !raw) return;

         const parsed = safeJsonParse<HistoryUpdate>(raw);
         if (!parsed) {
            console.log('[ROUTER] bad history json:', raw);
            return;
         }

         historyCache.set(userId, parsed.history ?? []);
         console.log(
            `[ROUTER] history updated (${userId}) len=${parsed.history?.length ?? 0}`
         );
      },
   }),

   inputConsumer.run({
      eachMessage: async ({ message }) => {
         const userId = message.key?.toString() ?? '';
         const raw = message.value?.toString() ?? '';
         if (!userId || !raw) return;

         const parsed = safeJsonParse<UserInputEvent>(raw);
         if (!parsed) {
            console.log('[ROUTER] bad input json:', raw);
            return;
         }

         const text = parsed.userInput.trim();
         console.log(`[ROUTER] input (${userId}): ${text}`);

         if (text === '/reset') {
            const ev: UserControlEvent = { command: 'reset' };
            await sendJson(producer, TOPICS.USER_CONTROL, userId, ev);
            console.log(`[ROUTER] -> control reset (${userId})`);
            return;
         }

         const decision = await classifyWithLLM(text);

         await sendJson(producer, TOPICS.ROUTER_DECISION, userId, {
            intent: decision.intent,
            parameters: decision.parameters,
            confidence: decision.confidence,
            userInput: text,
         });
         console.log(
            `[ROUTER] -> decision (${userId}) intent=${decision.intent} conf=${decision.confidence}`
         );

         switch (decision.intent) {
            case 'getWeather': {
               const city =
                  typeof decision.parameters.city === 'string'
                     ? decision.parameters.city.trim()
                     : '';
               if (!city) {
                  await sendJson(producer, TOPICS.APP_RESULTS, userId, {
                     type: 'chat',
                     result: 'Please specify a city for the weather query.',
                  });
                  console.log(`[ROUTER] -> no city for weather (${userId})`);
               } else {
                  await sendJson(producer, TOPICS.INTENT_WEATHER, userId, { city });
                  console.log(`[ROUTER] -> intent-weather (${userId}) ${city}`);
               }
               break;
            }
            case 'getExchangeRate': {
               const from =
                  typeof decision.parameters.from === 'string'
                     ? decision.parameters.from.trim().toUpperCase()
                     : 'USD';
               await sendJson(producer, TOPICS.INTENT_EXCHANGE, userId, {
                  currencyCode: from,
               });
               console.log(`[ROUTER] -> intent-exchange (${userId}) ${from}`);
               break;
            }
            case 'calculateMath': {
               const expression =
                  typeof decision.parameters.expression === 'string' &&
                  decision.parameters.expression.trim()
                     ? decision.parameters.expression.trim()
                     : '';
               const textProblem =
                  typeof decision.parameters.textProblem === 'string'
                     ? decision.parameters.textProblem.trim()
                     : '';
               const isCleanMath =
                  expression &&
                  !textProblem &&
                  /^[0-9+\-*/().\s]+$/.test(expression);
               if (isCleanMath) {
                  await sendJson(producer, TOPICS.INTENT_MATH, userId, {
                     expression,
                  });
                  console.log(`[ROUTER] -> intent-math (${userId}) ${expression}`);
               } else {
                  console.log(
                     `[ROUTER] -> calculateMath word problem (${userId}), CoT service will handle`
                  );
               }
               break;
            }
            default: {
               const context = historyCache.get(userId) ?? [];
               await sendJson(producer, TOPICS.INTENT_GENERAL_CHAT, userId, {
                  userInput: text,
                  context,
               });
               console.log(
                  `[ROUTER] -> intent-general-chat (${userId}) ctx=${context.length}`
               );
            }
         }
      },
   }),
]);
