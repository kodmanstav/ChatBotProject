import { createKafkaClient, TOPICS } from '../kafka/client';
import { runConsumer } from '../kafka/consumer';
import { publishValidated } from '../kafka/producer';
import { generatePlan } from '../services/llm-router.service';
import { logError, logExecution } from '../utils/logger';
import type { PlanGeneratedEvent } from '../types/events';

const USER_COMMANDS_TOPIC = TOPICS.USER_COMMANDS;
const CONVERSATION_EVENTS_TOPIC = TOPICS.CONVERSATION_EVENTS;
const CONSUMER_GROUP = 'router-group-debug';
const RECENT_PLAN_TTL_MS =
   Number(process.env.ROUTER_RECENT_PLAN_TTL_MS) || 120_000;
const inFlightConversations = new Set<string>();
const recentlyPlannedConversations = new Map<string, number>();

type GeneratedPlan = {
   plan: Array<{
      step: number;
      tool: string;
      parameters: Record<string, unknown>;
   }>;
   final_answer_synthesis_required: boolean;
};

function isRecord(v: unknown): v is Record<string, unknown> {
   return v != null && typeof v === 'object' && !Array.isArray(v);
}

function normalizeUserQuery(payload: unknown): {
   conversationId: string;
   userInput: string;
   timestamp: string;
} | null {
   if (!isRecord(payload)) return null;

   if (
      payload.eventType === 'UserQueryReceived' &&
      typeof payload.conversationId === 'string' &&
      typeof payload.timestamp === 'string' &&
      isRecord(payload.payload) &&
      typeof payload.payload.userInput === 'string'
   ) {
      return {
         conversationId: payload.conversationId,
         userInput: payload.payload.userInput,
         timestamp: payload.timestamp,
      };
   }

   if (
      typeof payload.conversationId === 'string' &&
      typeof payload.userInput === 'string'
   ) {
      return {
         conversationId: payload.conversationId,
         userInput: payload.userInput,
         timestamp:
            typeof payload.timestamp === 'string'
               ? payload.timestamp
               : new Date().toISOString(),
      };
   }

   if (
      typeof payload.conversationId === 'string' &&
      isRecord(payload.payload) &&
      typeof payload.payload.userInput === 'string'
   ) {
      return {
         conversationId: payload.conversationId,
         userInput: payload.payload.userInput,
         timestamp:
            typeof payload.timestamp === 'string'
               ? payload.timestamp
               : new Date().toISOString(),
      };
   }

   return null;
}

function isValidPlan(plan: unknown): plan is GeneratedPlan {
   if (!isRecord(plan)) return false;
   if (!Array.isArray(plan.plan)) return false;
   if (typeof plan.final_answer_synthesis_required !== 'boolean') return false;

   for (const step of plan.plan) {
      if (!isRecord(step)) return false;
      if (typeof step.step !== 'number') return false;
      if (typeof step.tool !== 'string') return false;
      if (!isRecord(step.parameters)) return false;
   }

   return true;
}

function sanitizeMathExpression(raw: string): string | null {
   const trimmed = raw.trim();
   if (!trimmed) return null;

   // Generic sanitization: remove function-call identifiers and keep only grouping.
   // Example: anyName(1+2) -> (1+2)
   const withoutFunctionNames = trimmed.replace(
      /\b[a-zA-Z_][a-zA-Z0-9_]*\s*\(/g,
      '('
   );
   const normalized = withoutFunctionNames.replace(/\s+/g, ' ').trim();

   // Allow placeholders used by orchestration plus arithmetic tokens only.
   const placeholderSafe = normalized.replace(
      /\{\{\s*steps\.\d+\.result\.[a-zA-Z0-9_]+\s*\}\}/g,
      '1'
   );
   if (!/^[\d+\-*/().\s]+$/.test(placeholderSafe)) return null;
   return normalized;
}

function normalizePlan(plan: GeneratedPlan): GeneratedPlan {
   return {
      ...plan,
      plan: plan.plan.map((step) => {
         const parameters: Record<string, unknown> = { ...step.parameters };

         for (const [key, value] of Object.entries(parameters)) {
            if (typeof value === 'string') {
               parameters[key] = value.replace(
                  /\{\{\s*steps\.(\d+)\.rate\s*\}\}/g,
                  '{{steps.$1.result.rate}}'
               );
            }
         }

         if (step.tool === 'calculateMath') {
            const expression = parameters.expression;
            if (typeof expression === 'string') {
               const sanitized = sanitizeMathExpression(expression);
               parameters.expression = sanitized ?? '0';
            } else {
               parameters.expression = '0';
            }
         }

         return { ...step, parameters };
      }),
   };
}

async function main(): Promise<void> {
   const kafka = createKafkaClient('router');
   const producer = kafka.producer();

   await producer.connect();
   console.log('[Router] Producer connected');
   console.log(
      `[Router] Listening on topic=${USER_COMMANDS_TOPIC} groupId=${CONSUMER_GROUP}`
   );

   await runConsumer(kafka, {
      topic: USER_COMMANDS_TOPIC,
      groupId: CONSUMER_GROUP,
      onMessage: async (payload) => {
         try {
            console.log(
               '[Router] RAW MESSAGE RECEIVED:',
               JSON.stringify(payload, null, 2)
            );

            const normalized = normalizeUserQuery(payload);

            if (!normalized) {
               const eventType =
                  payload &&
                  typeof payload === 'object' &&
                  'eventType' in (payload as Record<string, unknown>)
                     ? String((payload as Record<string, unknown>).eventType)
                     : 'unknown';

               console.log(`[Router] Skipping non-user event: ${eventType}`);
               return;
            }

            const { conversationId } = normalized;
            const userInput = normalized.userInput.trim();

            if (!userInput) {
               logError(
                  `[Router] Empty userInput for conversation ${conversationId}`
               );
               return;
            }

            const now = Date.now();
            const recentUntil =
               recentlyPlannedConversations.get(conversationId) ?? 0;
            if (recentUntil > now) {
               console.log(
                  `[Router] Skipping duplicate query for conversation ${conversationId} (recently planned)`
               );
               return;
            }
            if (inFlightConversations.has(conversationId)) {
               console.log(
                  `[Router] Skipping duplicate query for conversation ${conversationId} (already in progress)`
               );
               return;
            }
            inFlightConversations.add(conversationId);

            try {
               console.log(
                  `[Router] Received user query for conversation ${conversationId}`
               );
               console.log(`[Router] User input: ${userInput}`);

               let plan: GeneratedPlan | null = null;

               try {
                  const generated = await generatePlan(userInput);
                  console.log(
                     '[Router] Raw generated plan:',
                     JSON.stringify(generated, null, 2)
                  );

                  if (generated && isValidPlan(generated)) {
                     plan = generated;
                  } else {
                     logError('[Router] LLM returned invalid plan, skipping.');
                     return;
                  }
               } catch (err) {
                  logError('[Router] generatePlan failed, skipping.', err);
                  return;
               }

               if (!plan) return;

               try {
                  plan = normalizePlan(plan);
               } catch (e) {
                  logError('[Router] Failed to normalize generated plan', e);
               }

               console.log(
                  `[Router] Generated plan with ${plan.plan.length} step(s)`
               );
               console.log(
                  '[Router] Final plan:',
                  JSON.stringify(plan, null, 2)
               );

               const event: PlanGeneratedEvent = {
                  eventType: 'PlanGenerated',
                  conversationId,
                  timestamp: new Date().toISOString(),
                  payload: {
                     plan: plan.plan,
                     final_answer_synthesis_required:
                        plan.final_answer_synthesis_required,
                  },
               };

               const ok = await publishValidated(producer, {
                  topic: CONVERSATION_EVENTS_TOPIC,
                  value: event,
                  sendToDlqOnValidationFailure: true,
               });

               if (ok) {
                  recentlyPlannedConversations.set(
                     conversationId,
                     Date.now() + RECENT_PLAN_TTL_MS
                  );
                  console.log(
                     `[Router] Published PlanGenerated for conversation ${conversationId}`
                  );
                  logExecution('router', conversationId, 'PlanGenerated', {
                     steps: plan.plan.length,
                     tools: plan.plan.map((s) => s.tool),
                     final_answer_synthesis_required:
                        plan.final_answer_synthesis_required,
                  });
               } else {
                  logError(
                     `[Router] Failed to publish PlanGenerated for conversation ${conversationId}`
                  );
               }
            } finally {
               inFlightConversations.delete(conversationId);
            }
         } catch (err) {
            logError('[Router] Error while processing message:', err);
         }
      },
   });
}

main().catch((err) => {
   logError('[Router] fatal:', err);
   process.exit(1);
});
