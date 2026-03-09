export interface BaseEvent {
   eventType: string;
   conversationId: string;
   timestamp: string;
   payload: unknown;
}

export interface UserQueryReceivedEvent extends BaseEvent {
   eventType: 'UserQueryReceived';
   payload: { userInput: string };
}

export interface SynthesizeFinalAnswerRequestedEvent extends BaseEvent {
   eventType: 'SynthesizeFinalAnswerRequested';
   payload: { planResults: Record<string, unknown> };
}

export interface PlanGeneratedEvent extends BaseEvent {
   eventType: 'PlanGenerated';
   payload: {
      plan: Array<{
         step: number;
         tool: string;
         parameters: Record<string, unknown>;
      }>;
      final_answer_synthesis_required?: boolean;
   };
}

export interface ToolInvocationRequestedEvent extends BaseEvent {
   eventType: 'ToolInvocationRequested';
   payload: { step: number; tool: string; parameters: Record<string, unknown> };
}

export interface ToolInvocationResultedEvent extends BaseEvent {
   eventType: 'ToolInvocationResulted';
   payload: { step?: number; tool: string; success: boolean; result: unknown };
}

export interface PlanCompletedEvent extends BaseEvent {
   eventType: 'PlanCompleted';
   payload: { completedSteps: number; results: Record<string, unknown> };
}

export interface PlanFailedEvent extends BaseEvent {
   eventType: 'PlanFailed';
   payload: { failedStep: number; reason: string };
}

export interface PlanStepCompletedEvent extends BaseEvent {
   eventType: 'PlanStepCompleted';
   payload: { step: number; status: string };
}

export interface FinalAnswerSynthesizedEvent extends BaseEvent {
   eventType: 'FinalAnswerSynthesized';
   payload: { finalAnswer: string };
}

export type ConversationEvent =
   | PlanGeneratedEvent
   | ToolInvocationRequestedEvent
   | ToolInvocationResultedEvent
   | PlanStepCompletedEvent
   | PlanCompletedEvent
   | PlanFailedEvent
   | FinalAnswerSynthesizedEvent;
