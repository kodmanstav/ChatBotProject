import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(import.meta.dir, '..', '.env') });

import OpenAI from 'openai';
import {
   createConsumer,
   createProducer,
   safeJsonParse,
   runConsumer,
   sendRaw,
} from './shared/kafka';
import { TOPICS } from './shared/topics';
import { ROUTER_SYSTEM_PROMPT } from '../prompts';

type RouterDecisionEvent = {
   userInput?: string;
   intent?: string;
   parameters?: Record<string, unknown>;
   confidence?: number;
};

const LLM_JSON_ONLY_INSTRUCTION = `
You must respond with valid JSON only. No markdown, no code fences, no explanation, no text before or after.
The JSON must contain only these three fields: "intent", "parameters", "confidence".
Valid intents: getWeather, getExchangeRate, calculateMath, generalChat.
`;

const consumer = await createConsumer(
   'llm-handler-consumer',
   'llm-handler-router-decision-group'
);
const producer = await createProducer('llm-handler-producer');

const apiKey = process.env.OPENAI_API_KEY;
const openai = apiKey ? new OpenAI({ apiKey }) : null;

console.log('[LLM-HANDLER] starting, subscribing to', TOPICS.ROUTER_DECISION);

await consumer.subscribe({
   topic: TOPICS.ROUTER_DECISION,
   fromBeginning: false,
});

await consumer.run({
   eachMessage: async ({ message }) => {
      const userId = message.key?.toString() ?? '';
      const raw = message.value?.toString() ?? '';
      if (!userId || !raw) return;

      const parsed = safeJsonParse<RouterDecisionEvent>(raw);
      const userInput =
         typeof parsed?.userInput === 'string' ? parsed.userInput.trim() : '';
      if (!userInput) {
         console.log('[LLM-HANDLER] no userInput in event, skip');
         return;
      }

      if (!openai) {
         console.log('[LLM-HANDLER] no OPENAI_API_KEY, skip');
         return;
      }

      try {
         const resp = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
            messages: [
               { role: 'system', content: ROUTER_SYSTEM_PROMPT + LLM_JSON_ONLY_INSTRUCTION },
               { role: 'user', content: userInput },
            ],
            temperature: 0.2,
            max_tokens: 300,
            response_format: { type: 'json_object' },
         });

         const content = resp.choices?.[0]?.message?.content?.trim();
         if (!content) {
            console.log('[LLM-HANDLER] empty LLM response');
            return;
         }

         await sendRaw(producer, TOPICS.LLM_RESPONSE, userId, content);
         console.log('[LLM-HANDLER] published raw to llm_response_events', userId);
      } catch (err) {
         console.error('[LLM-HANDLER] LLM error:', (err as Error)?.message ?? err);
      }
   },
});
