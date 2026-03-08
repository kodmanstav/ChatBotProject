import OpenAI from 'openai';
import { ROUTER_PROMPT } from '../prompts/router.prompt';
import type { RouterIntent, RouterResult } from '../types';
import { parseJsonFences } from '../utils/json';

const VALID_INTENTS: RouterIntent[] = ['analyzeReview', 'generalChat'];

function getOpenAI(): OpenAI | null {
   const apiKey = process.env.OPENAI_API_KEY;
   return apiKey ? new OpenAI({ apiKey }) : null;
}

/**
 * Classify text as analyzeReview (actual review) or generalChat (casual chat).
 */
export async function routeText(text: string): Promise<RouterResult> {
   const openai = getOpenAI();
   if (!openai) {
      return { intent: 'generalChat' };
   }
   const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      messages: [
         { role: 'system', content: ROUTER_PROMPT },
         { role: 'user', content: text.trim() },
      ],
      temperature: 0.1,
      max_tokens: 50,
   });
   const raw = resp.choices?.[0]?.message?.content?.trim() ?? '';

   const parsed = parseJsonFences<{ intent?: string }>(raw);
   const intent =
      parsed?.intent && VALID_INTENTS.includes(parsed.intent as RouterIntent)
         ? (parsed.intent as RouterIntent)
         : 'generalChat';

   return { intent };
}
