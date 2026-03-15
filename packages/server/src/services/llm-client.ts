import OpenAI from 'openai';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434/api/chat';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3';

export function getOpenAI(): OpenAI | null {
   const apiKey = process.env.OPENAI_API_KEY;
   return apiKey ? new OpenAI({ apiKey }) : null;
}

export interface ChatMessage {
   role: 'system' | 'user' | 'assistant';
   content: string;
}

export async function callOllama(messages: ChatMessage[]): Promise<string> {
   console.log('[LLM] Using Ollama');
   const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
         model: OLLAMA_MODEL,
         stream: false,
         messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
   });
   if (!res.ok) throw new Error(`Ollama: ${res.status} ${res.statusText}`);
   const data = (await res.json()) as { message?: { content?: string } };
   const content = data.message?.content;
   if (typeof content !== 'string')
      throw new Error('Ollama: missing message.content');
   return content.trim();
}

export async function callOpenAI(messages: ChatMessage[]): Promise<string> {
   console.log('[LLM] Using OpenAI');
   const openai = getOpenAI();
   if (!openai) throw new Error('OPENAI_API_KEY not set');
   const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: 0.4,
      max_tokens: 1024,
   });
   const content = resp.choices?.[0]?.message?.content?.trim();
   if (!content) throw new Error('OpenAI: empty response');
   return content;
}

export async function callOllamaWithFallback(
   messages: ChatMessage[]
): Promise<string> {
   try {
      return await callOllama(messages);
   } catch {
      return callOpenAI(messages);
   }
}
