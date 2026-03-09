export interface PlanStep {
   step: number;
   tool: string;
   parameters: Record<string, unknown>;
}

export interface Plan {
   plan: PlanStep[];
   final_answer_synthesis_required: boolean;
}

export type PlanStateStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface PlanState {
   conversationId: string;
   plan: PlanStep[];
   stepIndex: number;
   status: PlanStateStatus;
   results: Record<string, unknown>;
   dispatchedSteps: number[];
   updatedAt: string;
}
