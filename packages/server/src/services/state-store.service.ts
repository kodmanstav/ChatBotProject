import type { PlanState } from '../types/plan';

const store = new Map<string, PlanState>();

export function getPlanState(conversationId: string): PlanState | null {
   return store.get(conversationId) ?? null;
}

export function setPlanState(state: PlanState): void {
   store.set(state.conversationId, {
      ...state,
      updatedAt: new Date().toISOString(),
   });
}

export function deletePlanState(conversationId: string): void {
   store.delete(conversationId);
}

export function hasPlanState(conversationId: string): boolean {
   return store.has(conversationId);
}
