/**
 * Safe JSON parse. Returns null on invalid input.
 */
export function safeJsonParse<T>(raw: string): T | null {
   try {
      return JSON.parse(raw) as T;
   } catch {
      return null;
   }
}

/**
 * Strip markdown code fences (e.g. ```json ... ```) and parse.
 */
export function parseJsonFences<T>(raw: string): T | null {
   const trimmed = raw.trim();
   const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
   const body = match?.[1] != null ? match[1].trim() : trimmed;
   return safeJsonParse<T>(body);
}
