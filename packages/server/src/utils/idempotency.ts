const processed = new Set<string>();

export function idempotencyKey(
   conversationId: string,
   step: number,
   tool: string
): string {
   return `${conversationId}:${step}:${tool}`;
}

export function alreadyProcessed(
   conversationId: string,
   step: number,
   tool: string
): boolean {
   return processed.has(idempotencyKey(conversationId, step, tool));
}

export function markProcessed(
   conversationId: string,
   step: number,
   tool: string
): void {
   processed.add(idempotencyKey(conversationId, step, tool));
}
