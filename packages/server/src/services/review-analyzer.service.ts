import OpenAI from 'openai';
import {
   REVIEW_ANALYZER_PROMPT,
   REVIEW_CORRECTION_PROMPT,
} from '../prompts/review-analyzer.prompt';
import type { AspectInsight, ReviewAnalysisResult } from '../types';
import { parseJsonFences, safeJsonParse } from '../utils/json';

function getOpenAI(): OpenAI | null {
   const apiKey = process.env.OPENAI_API_KEY;
   return apiKey ? new OpenAI({ apiKey }) : null;
}

async function callLlm(
   systemPrompt: string,
   userMessage: string,
   maxTokens = 500
): Promise<string> {
   const openai = getOpenAI();
   if (!openai) throw new Error('OPENAI_API_KEY not set');
   const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      messages: [
         { role: 'system', content: systemPrompt },
         { role: 'user', content: userMessage },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
   });
   return resp.choices?.[0]?.message?.content?.trim() ?? '';
}

function normalizeAnalysis(parsed: unknown): ReviewAnalysisResult | null {
   if (!parsed || typeof parsed !== 'object') return null;
   const o = parsed as Record<string, unknown>;
   const summary = typeof o.summary === 'string' ? o.summary : '';
   const overall_sentiment =
      o.overall_sentiment === 'Positive' ||
      o.overall_sentiment === 'Negative' ||
      o.overall_sentiment === 'Neutral'
         ? o.overall_sentiment
         : null;
   const score =
      typeof o.score === 'number' && Number.isFinite(o.score)
         ? Math.max(1, Math.min(5, Math.round(o.score)))
         : null;
   const aspects = Array.isArray(o.aspects)
      ? (o.aspects as unknown[]).filter((a): a is AspectInsight => {
           return (
              a != null &&
              typeof a === 'object' &&
              typeof (a as Record<string, unknown>).name === 'string' &&
              ((a as Record<string, unknown>).sentiment === 'Positive' ||
                 (a as Record<string, unknown>).sentiment === 'Negative' ||
                 (a as Record<string, unknown>).sentiment === 'Neutral') &&
              typeof (a as Record<string, unknown>).mention === 'string'
           );
        })
      : [];

   if (overall_sentiment === null || score === null) return null;
   return { summary, overall_sentiment, score, aspects };
}

/**
 * Call LLM to analyze review and return structured result.
 */
export async function analyzeReview(
   reviewText: string
): Promise<ReviewAnalysisResult | null> {
   const raw = await callLlm(REVIEW_ANALYZER_PROMPT, reviewText.trim());

   const parsed = parseJsonFences<unknown>(raw) ?? safeJsonParse<unknown>(raw);
   return normalizeAnalysis(parsed);
}

/**
 * Check if score and overall_sentiment are inconsistent (e.g. Positive but score < 4).
 */
export function shouldSelfCorrect(result: ReviewAnalysisResult): boolean {
   return result.score < 4 && result.overall_sentiment === 'Positive';
}

/**
 * Call LLM again with correction prompt; return corrected analysis or original on failure.
 */
export async function correctAnalysis(
   reviewText: string,
   inconsistentResult: ReviewAnalysisResult
): Promise<ReviewAnalysisResult> {
   const userMessage = `Original review:\n${reviewText}\n\nInconsistent JSON to fix:\n${JSON.stringify(inconsistentResult, null, 2)}`;
   const raw = await callLlm(REVIEW_CORRECTION_PROMPT, userMessage);

   const parsed = parseJsonFences<unknown>(raw) ?? safeJsonParse<unknown>(raw);
   const corrected = normalizeAnalysis(parsed);
   return corrected ?? inconsistentResult;
}
