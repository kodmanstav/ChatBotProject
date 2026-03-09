/**
 * Resolve placeholders like {{steps.1.result.city}} using a results map keyed by step number.
 * results["1"] = { city: "Tel Aviv" } => "{{steps.1.result.city}}" -> "Tel Aviv"
 */

export function resolvePlaceholders(
   parameters: Record<string, unknown>,
   results: Record<string, unknown>
): Record<string, unknown> {
   const out: Record<string, unknown> = {};
   for (const [key, value] of Object.entries(parameters)) {
      out[key] = resolveValue(value, results);
   }
   return out;
}

function resolveValue(
   value: unknown,
   results: Record<string, unknown>
): unknown {
   if (typeof value === 'string') {
      const resolved = resolveString(value, results);
      return resolved !== undefined ? resolved : value;
   }
   if (Array.isArray(value)) {
      return value.map((v) => resolveValue(v, results));
   }
   if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
         out[k] = resolveValue(v, results);
      }
      return out;
   }
   return value;
}

const PLACEHOLDER_REGEX = /\{\{\s*steps\.(\d+)\.result(?:\.([^}]+))?\s*\}\}/g;

function resolveString(
   str: string,
   results: Record<string, unknown>
): string | undefined {
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
      return current != null ? String(current) : '';
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
 */
export function resolveStepParameters(
   parameters: Record<string, unknown>,
   results: Record<string, unknown>
): Record<string, unknown> | null {
   try {
      const resolved = resolvePlaceholders(parameters, results);
      if (hasUnresolvedPlaceholders(resolved)) return null;
      return resolved;
   } catch {
      return null;
   }
}
