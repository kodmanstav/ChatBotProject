/**
 * Helpers for end-to-end latency from a list of Kafka event payloads
 * (same conversationId). Each event should expose `timestamp` (ISO string)
 * and `eventType`.
 */

export type LatencyEvent = {
   eventType: string;
   conversationId: string;
   timestamp: string;
};

function parseTs(iso: string): number | null {
   const t = Date.parse(iso);
   return Number.isFinite(t) ? t : null;
}

/**
 * Wall-clock ms from first UserQueryReceived to last FinalAnswerSynthesized
 * for the given conversation. Returns null if either anchor is missing or
 * timestamps are invalid.
 */
export function computeEndToEndLatencyMs(
   events: LatencyEvent[],
   conversationId: string
): number | null {
   const same = events.filter((e) => e.conversationId === conversationId);
   const starts = same
      .filter((e) => e.eventType === 'UserQueryReceived')
      .map((e) => ({ t: parseTs(e.timestamp), e }))
      .filter((x): x is { t: number; e: LatencyEvent } => x.t != null)
      .sort((a, b) => a.t - b.t);
   const ends = same
      .filter((e) => e.eventType === 'FinalAnswerSynthesized')
      .map((e) => ({ t: parseTs(e.timestamp), e }))
      .filter((x): x is { t: number; e: LatencyEvent } => x.t != null)
      .sort((a, b) => a.t - b.t);

   if (starts.length === 0 || ends.length === 0) return null;
   const t0 = starts[0]!.t;
   const t1 = ends[ends.length - 1]!.t;
   const delta = t1 - t0;
   return delta >= 0 ? delta : null;
}
