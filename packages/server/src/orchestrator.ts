import { createKafkaClient, TOPICS } from './kafka/client';
import { runConsumerMulti } from './kafka/consumer';
import { publishValidated } from './kafka/producer';
import * as stateStore from './services/state-store.service';
import { resolveStepParameters } from './utils/placeholder-resolver';
import type { PlanState, PlanStep } from './types/plan';
import type {
   PlanGeneratedEvent,
   ToolInvocationResultedEvent,
   ToolInvocationRequestedEvent,
   PlanCompletedEvent,
   PlanFailedEvent,
} from './types/events';
import { logError, logExecution } from './utils/logger';

const CONVERSATION_EVENTS_TOPIC = TOPICS.CONVERSATION_EVENTS;
const TOOL_INVOCATION_REQUESTS_TOPIC = TOPICS.TOOL_INVOCATION_REQUESTS;
const CONSUMER_GROUP = 'orchestrator-group';

function isPlanGenerated(payload: unknown): payload is PlanGeneratedEvent {
   if (payload == null || typeof payload !== 'object') return false;
   const o = payload as Record<string, unknown>;
   if (o.eventType !== 'PlanGenerated') return false;
   if (typeof o.conversationId !== 'string') return false;
   if (o.payload == null || typeof o.payload !== 'object') return false;
   const p = o.payload as Record<string, unknown>;
   return Array.isArray(p.plan);
}

function isToolInvocationResulted(
   payload: unknown
): payload is ToolInvocationResultedEvent {
   if (payload == null || typeof payload !== 'object') return false;
   const o = payload as Record<string, unknown>;
   if (o.eventType !== 'ToolInvocationResulted') return false;
   if (typeof o.conversationId !== 'string') return false;
   if (o.payload == null || typeof o.payload !== 'object') return false;
   const p = o.payload as Record<string, unknown>;
   return typeof p.tool === 'string' && typeof p.success === 'boolean';
}

function isToolInvocationRequested(
   payload: unknown
): payload is ToolInvocationRequestedEvent {
   if (payload == null || typeof payload !== 'object') return false;
   const o = payload as Record<string, unknown>;
   return (
      o.eventType === 'ToolInvocationRequested' &&
      typeof o.conversationId === 'string'
   );
}

function initPlanState(conversationId: string, plan: PlanStep[]): PlanState {
   return {
      conversationId,
      plan,
      stepIndex: 0,
      status: 'PENDING',
      results: {},
      dispatchedSteps: [],
      updatedAt: new Date().toISOString(),
   };
}

async function dispatchStep(
   producer: Awaited<
      ReturnType<ReturnType<typeof createKafkaClient>['producer']>
   >,
   conversationId: string,
   step: PlanStep,
   resolvedParams: Record<string, unknown>
): Promise<boolean> {
   const event: ToolInvocationRequestedEvent = {
      eventType: 'ToolInvocationRequested',
      conversationId,
      timestamp: new Date().toISOString(),
      payload: {
         step: step.step,
         tool: step.tool,
         parameters: resolvedParams,
      },
   };

   return publishValidated(producer, {
      topic: TOOL_INVOCATION_REQUESTS_TOPIC,
      value: event,
      sendToDlqOnValidationFailure: true,
   });
}

async function publishPlanCompleted(
   producer: Awaited<
      ReturnType<ReturnType<typeof createKafkaClient>['producer']>
   >,
   conversationId: string,
   results: Record<string, unknown>
): Promise<void> {
   const event: PlanCompletedEvent = {
      eventType: 'PlanCompleted',
      conversationId,
      timestamp: new Date().toISOString(),
      payload: {
         completedSteps: Object.keys(results).length,
         results,
      },
   };

   await publishValidated(producer, {
      topic: CONVERSATION_EVENTS_TOPIC,
      value: event,
   });
}

async function publishPlanFailed(
   producer: Awaited<
      ReturnType<ReturnType<typeof createKafkaClient>['producer']>
   >,
   conversationId: string,
   failedStep: number,
   reason: string
): Promise<void> {
   const event: PlanFailedEvent = {
      eventType: 'PlanFailed',
      conversationId,
      timestamp: new Date().toISOString(),
      payload: { failedStep, reason },
   };

   await publishValidated(producer, {
      topic: CONVERSATION_EVENTS_TOPIC,
      value: event,
   });
}

async function main(): Promise<void> {
   const kafka = createKafkaClient('orchestrator');
   const producer = kafka.producer();
   await producer.connect();

   await runConsumerMulti(kafka, {
      topics: [CONVERSATION_EVENTS_TOPIC, TOOL_INVOCATION_REQUESTS_TOPIC],
      groupId: CONSUMER_GROUP,
      onMessage: async (payload, _raw, topic) => {
         if (topic === TOOL_INVOCATION_REQUESTS_TOPIC) {
            if (isToolInvocationRequested(payload)) {
               const state = await stateStore.getPlanState(
                  payload.conversationId
               );
               if (
                  state &&
                  !state.dispatchedSteps.includes(payload.payload.step)
               ) {
                  state.dispatchedSteps = [
                     ...state.dispatchedSteps,
                     payload.payload.step,
                  ].sort((a, b) => a - b);
                  await stateStore.setPlanState(state);
               }
            }
            return;
         }

         if (topic !== CONVERSATION_EVENTS_TOPIC) return;

         if (isPlanGenerated(payload)) {
            const { conversationId, payload: pl } = payload;
            const plan = pl.plan;
            if (!plan.length) return;

            const firstStep = plan[0];
            if (!firstStep) return;

            const state = initPlanState(conversationId, plan);
            await stateStore.setPlanState(state);

            console.log(
               `[Orchestrator] Initialized state for conversation ${conversationId}`
            );
            logExecution('orchestrator', conversationId, 'PlanInitialized', {
               steps: plan.length,
               tools: plan.map((s) => s.tool),
            });

            const resolved = resolveStepParameters(
               firstStep.parameters,
               state.results
            );
            if (resolved === null) {
               await publishPlanFailed(
                  producer,
                  conversationId,
                  firstStep.step,
                  'Placeholder resolution failed for first step'
               );
               await stateStore.deletePlanState(conversationId);
               return;
            }

            state.status = 'RUNNING';

            const ok = await dispatchStep(
               producer,
               conversationId,
               firstStep,
               resolved
            );
            if (ok) {
               state.dispatchedSteps = [firstStep.step];
               await stateStore.setPlanState(state);
               console.log(
                  `[Orchestrator] Dispatching step ${firstStep.step} -> ${firstStep.tool}`
               );
               console.log(
                  '[Orchestrator] Resolved parameters:',
                  JSON.stringify(resolved, null, 2)
               );
               logExecution('orchestrator', conversationId, 'StepDispatched', {
                  step: firstStep.step,
                  tool: firstStep.tool,
               });
            }

            return;
         }

         if (isToolInvocationResulted(payload)) {
            const { conversationId, payload: pl } = payload;
            const state = await stateStore.getPlanState(conversationId);
            if (!state) return;

            const stepNum =
               pl.step ?? state.plan.find((s) => s.tool === pl.tool)?.step;
            if (stepNum == null) return;

            console.log(
               `[Orchestrator] Received ToolInvocationResulted for step ${stepNum}`
            );
            logExecution(
               'orchestrator',
               conversationId,
               'ToolInvocationResulted',
               {
                  step: stepNum,
                  tool: pl.tool,
                  success: pl.success,
               }
            );

            if (!pl.success) {
               await publishPlanFailed(
                  producer,
                  conversationId,
                  stepNum,
                  'Tool invocation failed'
               );
               state.status = 'FAILED';
               await stateStore.setPlanState(state);
               await stateStore.deletePlanState(conversationId);
               return;
            }

            const results = { ...state.results, [String(stepNum)]: pl.result };
            state.results = results;
            state.updatedAt = new Date().toISOString();
            await stateStore.setPlanState(state);

            const completedCount = Object.keys(results).length;

            if (completedCount >= state.plan.length) {
               state.status = 'COMPLETED';
               await stateStore.setPlanState(state);
               await publishPlanCompleted(producer, conversationId, results);
               console.log(
                  `[Orchestrator] Plan completed for conversation ${conversationId}`
               );
               logExecution('orchestrator', conversationId, 'PlanCompleted', {
                  steps: completedCount,
               });
               await stateStore.deletePlanState(conversationId);
               return;
            }

            const nextStep = state.plan.find(
               (s) => !(String(s.step) in results)
            );
            if (!nextStep) {
               await stateStore.setPlanState(state);
               return;
            }

            if (state.dispatchedSteps.includes(nextStep.step)) {
               await stateStore.setPlanState(state);
               return;
            }

            const resolved = resolveStepParameters(
               nextStep.parameters,
               results
            );
            if (resolved === null) {
               await publishPlanFailed(
                  producer,
                  conversationId,
                  nextStep.step,
                  'Placeholder resolution failed'
               );
               state.status = 'FAILED';
               await stateStore.setPlanState(state);
               await stateStore.deletePlanState(conversationId);
               return;
            }

            console.log(
               `[Orchestrator] Resolved placeholders for step ${nextStep.step}`
            );
            console.log(
               '[Orchestrator] Resolved parameters:',
               JSON.stringify(resolved, null, 2)
            );

            const ok = await dispatchStep(
               producer,
               conversationId,
               nextStep,
               resolved
            );
            if (ok) {
               state.dispatchedSteps = [
                  ...state.dispatchedSteps,
                  nextStep.step,
               ].sort((a, b) => a - b);
               await stateStore.setPlanState(state);
               console.log(
                  `[Orchestrator] Dispatching step ${nextStep.step} -> ${nextStep.tool}`
               );
               logExecution('orchestrator', conversationId, 'StepDispatched', {
                  step: nextStep.step,
                  tool: nextStep.tool,
               });
            }
         }
      },
   });
}

main().catch((err) => {
   logError('Orchestrator fatal:', err);
   process.exit(1);
});
