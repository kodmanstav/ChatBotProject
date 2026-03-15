import OpenAI from 'openai';
import { ROUTER_SYSTEM_PROMPT } from '../prompts/router.prompt';
import type { Plan } from '../types/plan';
import { parseJsonFences } from '../utils/json';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434/api/chat';
const OLLAMA_MODEL = process.env.OLLAMA_ROUTER_MODEL ?? 'llama3';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 30_000;

function getOpenAI(): OpenAI | null {
   const apiKey = process.env.OPENAI_API_KEY;
   return apiKey ? new OpenAI({ apiKey }) : null;
}

function buildHeuristicPlan(userInput: string): Plan | null {
   const text = userInput.trim();
   if (!text) return null;

   const lower = text.toLowerCase();

   // Math-like expression: digits, operators, spaces, parentheses, optional question mark
   const mathLike = /^[\d\s+\-*/().?]+$/.test(text);
   if (mathLike) {
      return {
         plan: [
            {
               step: 1,
               tool: 'calculateMath',
               parameters: { expression: text.replace(/\?$/, '').trim() },
            },
         ],
         final_answer_synthesis_required: false,
      };
   }

   // Weather-related
   if (
      lower.includes('weather') ||
      lower.includes('מזג האוויר') ||
      lower.includes('מזג האויר')
   ) {
      return {
         plan: [
            {
               step: 1,
               tool: 'getWeather',
               parameters: { location: text },
            },
         ],
         final_answer_synthesis_required: false,
      };
   }

   // Currency / exchange-related (very simple heuristic)
   if (
      lower.includes('exchange') ||
      lower.includes('convert') ||
      lower.includes('rate')
   ) {
      return {
         plan: [
            {
               step: 1,
               tool: 'getExchangeRate',
               parameters: { from: 'USD', to: 'ILS' },
            },
         ],
         final_answer_synthesis_required: false,
      };
   }

   // Fallback: let downstream generalChat handle it if we don't have a better guess
   return null;
}

function normalizePlanPayload(raw: unknown): Plan | null {
   if (raw == null || typeof raw !== 'object') return null;
   const o = raw as Record<string, unknown>;
   const plan = o.plan;
   if (!Array.isArray(plan) || plan.length === 0) return null;
   const steps: Plan['plan'] = [];
   for (const s of plan) {
      if (s == null || typeof s !== 'object') return null;
      const step = s as Record<string, unknown>;
      const stepNum =
         typeof step.step === 'number'
            ? step.step
            : typeof step.step === 'string'
              ? parseInt(step.step, 10)
              : NaN;
      if (Number.isNaN(stepNum) || typeof step.tool !== 'string') return null;
      const parameters = step.parameters;
      steps.push({
         step: stepNum,
         tool: step.tool,
         parameters:
            parameters != null &&
            typeof parameters === 'object' &&
            !Array.isArray(parameters)
               ? (parameters as Record<string, unknown>)
               : {},
      });
   }
   const final_answer_synthesis_required =
      typeof o.final_answer_synthesis_required === 'boolean'
         ? o.final_answer_synthesis_required
         : true;
   return { plan: steps, final_answer_synthesis_required };
}

async function callOllama(userInput: string): Promise<string> {
   const controller = new AbortController();
   const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
   try {
      const res = await fetch(OLLAMA_URL, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
            model: OLLAMA_MODEL,
            stream: false,
            messages: [
               { role: 'system', content: ROUTER_SYSTEM_PROMPT.trim() },
               { role: 'user', content: userInput },
            ],
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

async function callOpenAI(userInput: string): Promise<string> {
   const openai = getOpenAI();
   if (!openai) throw new Error('OpenAI not configured (OPENAI_API_KEY)');
   const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      messages: [
         { role: 'system', content: ROUTER_SYSTEM_PROMPT.trim() },
         { role: 'user', content: userInput },
      ],
      temperature: 0.2,
      max_tokens: 1024,
   });
   const content = resp.choices?.[0]?.message?.content?.trim();
   if (!content) throw new Error('OpenAI: empty response');
   return content;
}

/**
 * Generate a plan from user input using Ollama, with OpenAI fallback on Ollama failure.
 * Returns normalized Plan or null if parsing/validation fails.
 */
export async function generatePlan(userInput: string): Promise<Plan | null> {
   // First, try simple rule-based routing so we don't depend on external LLMs
   const heuristic = buildHeuristicPlan(userInput);
   if (heuristic) {
      return heuristic;
   }

   let raw: string;
   console.log('[LLM Router] Using Ollama for plan generation', {
      url: OLLAMA_URL,
      model: OLLAMA_MODEL,
      timeoutMs: OLLAMA_TIMEOUT_MS,
   });
   try {
      raw = await callOllama(userInput);
      console.log('[LLM Router] Plan from Ollama (success)');
   } catch (ollamaErr) {
      const reason =
         ollamaErr instanceof Error ? ollamaErr.message : String(ollamaErr);
      console.warn(
         '[LLM Router] Ollama failed, falling back to OpenAI:',
         reason
      );
      try {
         raw = await callOpenAI(userInput);
         console.log(
            '[LLM Router] Plan from OpenAI (fallback; Ollama was unavailable)'
         );
      } catch (openaiErr) {
         console.error('[LLM Router] Ollama failed:', ollamaErr);
         console.error('[LLM Router] OpenAI fallback also failed:', openaiErr);
         return null;
      }
   }
   console.log('[LLM Router] Response length:', raw.length);
   const parsed =
      parseJsonFences<unknown>(raw) ??
      (() => {
         try {
            return JSON.parse(raw) as unknown;
         } catch {
            return null;
         }
      })();
   if (parsed == null) {
      console.error('[LLM Router] Failed to parse JSON from LLM response');
      return null;
   }
   let plan = normalizePlanPayload(parsed);
   if (plan == null) {
      console.error(
         '[LLM Router] LLM response did not match expected plan structure'
      );
      console.error(
         '[LLM Router] Parsed payload:',
         JSON.stringify(parsed).slice(0, 500)
      );
      return null;
   }
   // Fix older placeholder style like {{steps.1.rate}} -> {{steps.1.result.rate}}
   try {
      plan = {
         ...plan,
         plan: plan.plan.map((step) => ({
            ...step,
            parameters: Object.fromEntries(
               Object.entries(step.parameters).map(([key, value]) => {
                  if (typeof value === 'string') {
                     return [
                        key,
                        value.replace(
                           /\{\{\s*steps\.(\d+)\.rate\s*\}\}/g,
                           '{{steps.$1.result.rate}}'
                        ),
                     ];
                  }
                  return [key, value];
               })
            ),
         })),
      };
   } catch (e) {
      console.error('[LLM Router] Failed to post-process placeholders:', e);
   }
   return plan;
}
