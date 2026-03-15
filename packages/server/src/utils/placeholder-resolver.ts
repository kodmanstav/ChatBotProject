/**
 * Resolve placeholders like {{steps.1.result.city}} using a results map keyed by step number.
 * results["1"] = { city: "Tel Aviv" } => "{{steps.1.result.city}}" -> "Tel Aviv"
 *
 * When a placeholder resolves to empty or non-numeric text and the parameter key is in
 * normalizeNumbersForParamKeys (e.g. "expression"), we try to extract the first number
 * from the step result text (e.g. retrieved_context) so math expressions get valid values.
 */

const DEFAULT_NORMALIZE_NUMBERS_FOR_PARAM_KEYS = ['expression'];

export type ResolveStepParametersOptions = {
   normalizeNumbersForParamKeys?: string[];
};

/**
 * Extract the first number from a string (e.g. "$1,499" or "Starting at $1,499").
 * Returns the number as a string with no commas, or null if none found.
 */
export function extractFirstNumberFromText(str: string): string | null {
   if (str == null || typeof str !== 'string') return null;
   const m = str.match(/\$?\s*([\d,]+(?:\.\d+)?)/);
   const group = m?.[1];
   if (group == null) return null;
   try {
      return group.replace(/,/g, '');
   } catch {
      return null;
   }
}

function isNumericString(s: string): boolean {
   const t = s.trim();
   return t !== '' && /^\d+(\.\d+)?$/.test(t);
}

export function resolvePlaceholders(
   parameters: Record<string, unknown>,
   results: Record<string, unknown>,
   options?: ResolveStepParametersOptions
): Record<string, unknown> {
   const normalizeKeys =
      options?.normalizeNumbersForParamKeys ??
      DEFAULT_NORMALIZE_NUMBERS_FOR_PARAM_KEYS;
   const out: Record<string, unknown> = {};
   for (const [key, value] of Object.entries(parameters)) {
      out[key] = resolveValue(value, results, normalizeKeys, key);
   }
   return out;
}

function resolveValue(
   value: unknown,
   results: Record<string, unknown>,
   normalizeNumbersForParamKeys: string[],
   paramKey?: string
): unknown {
   if (typeof value === 'string') {
      const resolved = resolveString(
         value,
         results,
         normalizeNumbersForParamKeys,
         paramKey
      );
      return resolved !== undefined ? resolved : value;
   }
   if (Array.isArray(value)) {
      return value.map((v) =>
         resolveValue(v, results, normalizeNumbersForParamKeys, undefined)
      );
   }
   if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
         out[k] = resolveValue(
            v,
            results,
            normalizeNumbersForParamKeys,
            undefined
         );
      }
      return out;
   }
   return value;
}

const PLACEHOLDER_REGEX = /\{\{\s*steps\.(\d+)\.result(?:\.([^}]+))?\s*\}\}/g;

function textFromStepResult(resultObj: Record<string, unknown>): string {
   const ctx = resultObj.retrieved_context ?? resultObj.text;
   if (typeof ctx === 'string') return ctx;
   return JSON.stringify(resultObj);
}

function resolveString(
   str: string,
   results: Record<string, unknown>,
   normalizeNumbersForParamKeys: string[],
   paramKey?: string
): string | undefined {
   const useNumericFallback =
      paramKey != null &&
      normalizeNumbersForParamKeys.length > 0 &&
      normalizeNumbersForParamKeys.includes(paramKey);

   let hadMatch = false;
   const resolved = str.replace(PLACEHOLDER_REGEX, (_, stepNum, path) => {
      hadMatch = true;
      const stepResult = results[String(stepNum)];
      if (
         stepResult == null ||
         typeof stepResult !== 'object' ||
         Array.isArray(stepResult)
      ) {
         return '';
      }
      const resultObj = stepResult as Record<string, unknown>;
      if (!path) {
         return typeof resultObj === 'object'
            ? JSON.stringify(resultObj)
            : String(resultObj);
      }
      const keys = path.trim().split('.');
      let current: unknown = resultObj;
      for (const k of keys) {
         if (current == null || typeof current !== 'object') return '';
         current = (current as Record<string, unknown>)[k];
      }
      let replacement = current != null ? String(current) : '';

      if (
         useNumericFallback &&
         (replacement === '' || !isNumericString(replacement))
      ) {
         const text = textFromStepResult(resultObj);
         const num = extractFirstNumberFromText(text);
         if (num != null) replacement = num;
      }
      return replacement;
   });
   return hadMatch ? resolved : undefined;
}

function hasUnresolvedPlaceholders(value: unknown): boolean {
   if (typeof value === 'string') return /\{\{\s*steps\./.test(value);
   if (Array.isArray(value)) return value.some(hasUnresolvedPlaceholders);
   if (value != null && typeof value === 'object') {
      return Object.values(value).some(hasUnresolvedPlaceholders);
   }
   return false;
}

/**
 * Resolve placeholders in a step's parameters. Returns resolved params or null if any placeholder cannot be resolved (e.g. missing step result).
 * When options.normalizeNumbersForParamKeys includes a parameter key (e.g. "expression"), placeholders that resolve to empty or non-numeric text will be replaced by the first number extracted from the step result text.
 */
export function resolveStepParameters(
   parameters: Record<string, unknown>,
   results: Record<string, unknown>,
   options?: ResolveStepParametersOptions
): Record<string, unknown> | null {
   try {
      const resolved = resolvePlaceholders(parameters, results, options);
      if (hasUnresolvedPlaceholders(resolved)) return null;
      return resolved;
   } catch {
      return null;
   }
}
