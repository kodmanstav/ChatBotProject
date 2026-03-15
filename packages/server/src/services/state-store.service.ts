import path from 'node:path';
import { Level } from 'level';
import type { PlanState } from '../types/plan';

const DB_PATH =
   process.env.ORCHESTRATOR_STATE_PATH ??
   path.join(process.cwd(), '.orchestrator-state');

const db = new Level<string, string>(DB_PATH, { valueEncoding: 'utf8' });

export async function getPlanState(
   conversationId: string
): Promise<PlanState | null> {
   try {
      const raw = await db.get(conversationId);
      const state = JSON.parse(raw) as PlanState;
      return state ?? null;
   } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code === 'LEVEL_NOT_FOUND') return null;
      throw err;
   }
}

export async function setPlanState(state: PlanState): Promise<void> {
   const toSave = {
      ...state,
      updatedAt: new Date().toISOString(),
   };
   await db.put(state.conversationId, JSON.stringify(toSave));
}

export async function deletePlanState(conversationId: string): Promise<void> {
   try {
      await db.del(conversationId);
   } catch (err: unknown) {}
}

export async function hasPlanState(conversationId: string): Promise<boolean> {
   try {
      await db.get(conversationId);
      return true;
   } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code === 'LEVEL_NOT_FOUND') return false;
      throw err;
   }
}
