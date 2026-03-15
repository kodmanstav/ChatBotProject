import OpenAI from 'openai';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434/api/chat';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 30_000;

export function getOpenAI(): OpenAI | null {
   const apiKey = process.env.OPENAI_API_KEY;
   return apiKey ? new OpenAI({ apiKey }) : null;
}

export interface ChatMessage {
   role: 'system' | 'user' | 'assistant';
   content: string;
}

export async function callOllama(messages: ChatMessage[]): Promise<string> {
   console.log('[LLM] Using Ollama', {
      url: OLLAMA_URL,
      model: OLLAMA_MODEL,
      timeoutMs: OLLAMA_TIMEOUT_MS,
   });
   const controller = new AbortController();
   const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
   try {
      const res = await fetch(OLLAMA_URL, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
            model: OLLAMA_MODEL,
            stream: false,
            messages: messages.map((m) => ({
               role: m.role,
               content: m.content,
            })),
         }),
         signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Ollama: ${res.status} ${res.statusText}`);
      const data = (await res.json()) as { message?: { content?: string } };
      const content = data.message?.content;
      if (typeof content !== 'string')
         throw new Error('Ollama: missing message.content');
      return content.trim();
   } finally {
      clearTimeout(timeoutId);
   }
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
   } catch (ollamaErr) {
      const reason =
         ollamaErr instanceof Error ? ollamaErr.message : String(ollamaErr);
      console.warn('[LLM] Ollama failed, falling back to OpenAI:', reason);
      return callOpenAI(messages);
   }
}
