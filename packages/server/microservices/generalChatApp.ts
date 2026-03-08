import dotenv from 'dotenv';
import path from 'path';
import { GENERAL_CHAT_SYSTEM_PROMPT } from '../prompts';
dotenv.config({ path: path.join(import.meta.dir, '..', '.env') });

import OpenAI from 'openai';
import {
   createConsumer,
   createProducer,
   safeJsonParse,
   sendJson,
   runConsumer,
} from './shared/kafka';
import { TOPICS } from './shared/topics';

type HistoryItem = { role: 'user' | 'assistant'; content: string; ts: number };
type GeneralChatIntent = { userInput: string; context: HistoryItem[] };

const producer = await createProducer('chat-producer');
const consumer = await createConsumer(
   'chat-consumer',
   'chat-consumer-intent-general-chat'
);

const apiKey = process.env.OPENAI_API_KEY;
const openai = apiKey ? new OpenAI({ apiKey }) : null;

function buildMessages(context: HistoryItem[], userInput: string) {
   const msgs: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
   }> = [
      {
         role: 'system',
         content: GENERAL_CHAT_SYSTEM_PROMPT,

      },
   ];

   const tail = context.slice(-10);
   for (const item of tail) {
      msgs.push({ role: item.role, content: item.content });
   }

   msgs.push({ role: 'user', content: userInput });
   return msgs;
}

await runConsumer(consumer, TOPICS.INTENT_GENERAL_CHAT, async ({ message }) => {
   const userId = message.key?.toString() ?? '';
   const parsed = safeJsonParse<GeneralChatIntent>(
      message.value?.toString() ?? ''
   );
   if (!userId || !parsed) return;

   let result = `קיבלתי: "${parsed.userInput}". (חסר OPENAI_API_KEY כדי לענות עם LLM)`;

   if (openai) {
      try {
         const messages = buildMessages(parsed.context ?? [], parsed.userInput);
         const resp = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
            messages,
            temperature: 0.7,
         });
         result =
            resp.choices?.[0]?.message?.content?.trim() ||
            'לא הצלחתי לייצר תשובה.';
      } catch (e) {
         result = `שגיאה בקריאה ל-LLM: ${(e as Error)?.message ?? String(e)}`;
      }
   }

   await sendJson(producer, TOPICS.APP_RESULTS, userId, {
      type: 'chat',
      result,
   });
   console.log(`[CHAT] (${userId}) ctx=${parsed.context?.length ?? 0}`);
});
