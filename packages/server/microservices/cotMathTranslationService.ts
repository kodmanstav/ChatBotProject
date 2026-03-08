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
   sendJson,
} from './shared/kafka';
import { TOPICS } from './shared/topics';
import { COT_MATH_EXPRESSION_PROMPT } from '../prompts';

type RouterDecisionEvent = {
   userInput?: string;
   intent?: string;
   parameters?: Record<string, unknown>;
   confidence?: number;
};

const CLEAN_MATH_REGEX = /^[0-9+\-*/().\s]+$/;

function isWordProblem(parameters: Record<string, unknown>): boolean {
   const textProblem =
      typeof parameters.textProblem === 'string'
         ? parameters.textProblem.trim()
         : '';
   const expression =
      typeof parameters.expression === 'string'
         ? parameters.expression.trim()
         : '';
   if (textProblem) return true;
   if (!expression) return true;
   if (!CLEAN_MATH_REGEX.test(expression)) return true;
   return false;
}

function getWordProblemText(parameters: Record<string, unknown>): string {
   const textProblem =
      typeof parameters.textProblem === 'string'
         ? parameters.textProblem.trim()
         : '';
   const expression =
      typeof parameters.expression === 'string'
         ? parameters.expression.trim()
         : '';
   return textProblem || expression || '';
}

function normalizeAndValidate(raw: string): string | null {
   const oneLine = raw.trim().replace(/\s+/g, ' ').replace(/\n/g, ' ');
   const trimmed = oneLine.trim();
   if (!trimmed) return null;
   if (!CLEAN_MATH_REGEX.test(trimmed)) return null;
   return trimmed;
}

const consumer = await createConsumer(
   'cot-math-consumer',
   'cot-math-router-decision-group'
);
const producer = await createProducer('cot-math-producer');

const apiKey = process.env.OPENAI_API_KEY;
const openai = apiKey ? new OpenAI({ apiKey }) : null;

console.log('[COT-MATH] starting, subscribing to', TOPICS.ROUTER_DECISION);

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
      if (!parsed || parsed.intent !== 'calculateMath') return;
      const parameters =
         parsed.parameters && typeof parsed.parameters === 'object'
            ? (parsed.parameters as Record<string, unknown>)
            : {};
      if (!isWordProblem(parameters)) return;

      const wordProblemText = getWordProblemText(parameters);
      if (!wordProblemText) return;

      if (!openai) {
         console.log('[COT-MATH] no OPENAI_API_KEY, skip');
         return;
      }

      try {
         const resp = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
            messages: [
               { role: 'system', content: COT_MATH_EXPRESSION_PROMPT },
               { role: 'user', content: wordProblemText },
            ],
            temperature: 0.2,
            max_tokens: 150,
         });

         const content = resp.choices?.[0]?.message?.content?.trim();
         if (!content) {
            console.log('[COT-MATH] empty LLM response');
            return;
         }

         const expression = normalizeAndValidate(content);
         if (expression) {
            await sendRaw(
               producer,
               TOPICS.COT_MATH_EXPRESSION,
               userId,
               expression
            );
            console.log('[COT-MATH] published expression', userId, expression);
         } else {
            await sendJson(producer, TOPICS.ERROR_EVENTS, userId, {
               sourceTopic: TOPICS.COT_MATH_EXPRESSION,
               reason: 'Invalid or unsafe expression from LLM',
               raw: content.slice(0, 500),
               timestamp: new Date().toISOString(),
            });
            console.log('[COT-MATH] invalid expression, sent to error_events');
         }
      } catch (err) {
         console.error('[COT-MATH] LLM error:', (err as Error)?.message ?? err);
      }
   },
});
