import { createKafkaClient, TOPICS } from './kafka/client';
import { runConsumer } from './kafka/consumer';
import { publishValidated } from './kafka/producer';
import { generatePlan } from './services/llm-router.service';
import { logError, logExecution } from './utils/logger';
import type { PlanGeneratedEvent } from './types/events';

const USER_COMMANDS_TOPIC = TOPICS.USER_COMMANDS;
const CONVERSATION_EVENTS_TOPIC = TOPICS.CONVERSATION_EVENTS;
const CONSUMER_GROUP = 'router-group-debug';

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

function sanitizeMathExpression(input: string): string {
   return input
      .replace(/=/g, '')
      .replace(/\?/g, '')
      .replace(/[^0-9+\-*/().\s]/g, '')
      .trim();
}

function looksLikeMath(input: string): boolean {
   const cleaned = sanitizeMathExpression(input);
   return /\d/.test(cleaned) && /[+\-*/]/.test(cleaned);
}

function looksLikeWeather(input: string): boolean {
   const s = input.toLowerCase();
   return (
      s.includes('weather') ||
      s.includes('temperature') ||
      s.includes('forecast') ||
      s.includes('rain') ||
      s.includes('sunny') ||
      s.includes('cloudy') ||
      s.includes('coat') ||
      s.includes('umbrella') ||
      s.includes('flying to') ||
      s.includes('should i bring')
   );
}

function looksLikeExchangeRate(input: string): boolean {
   const s = input.toLowerCase();
   return (
      s.includes('exchange') ||
      s.includes('rate') ||
      s.includes('usd') ||
      s.includes('eur') ||
      s.includes('gbp') ||
      s.includes('ils') ||
      s.includes('dollar') ||
      s.includes('shekel')
   );
}

function extractAmount(input: string): number | null {
   const match = input.match(/(\d+(?:\.\d+)?)/);
   if (!match) return null;

   const value = Number(match[1]);
   return Number.isFinite(value) ? value : null;
}

function extractCurrencies(input: string): { from: string; to: string } | null {
   const upper = input.toUpperCase();
   const codes = upper.match(/\b(USD|ILS|EUR|GBP)\b/g);

   if (codes && codes.length >= 2) {
      const from = codes[0];
      const to = codes[1];

      if (!from || !to) return null;
      return { from, to };
   }

   return null;
}

function cleanExtractedLocation(location: string): string {
   return location
      .replace(
         /\b(today|tomorrow|tonight|now|this week|next week|this weekend)\b/gi,
         ''
      )
      .replace(/[?,.]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
}

function extractCityFromWeatherQuery(input: string): string | null {
   const normalized = input.trim();

   const patterns = [
      /\b(?:in|for)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)/i,
      /\bflying to\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)/i,
      /\btravel(?:ing)? to\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)/i,
      /\bgoing to\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)/i,
   ];

   for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match?.[1]) {
         const cleaned = cleanExtractedLocation(match[1]);
         if (cleaned) return cleaned;
      }
   }

   const knownCities = [
      'London',
      'Paris',
      'Tel Aviv',
      'Jerusalem',
      'New York',
      'Bangkok',
      'Hanoi',
      'Tokyo',
      'Rome',
      'Berlin',
   ];

   const lower = normalized.toLowerCase();
   for (const city of knownCities) {
      if (lower.includes(city.toLowerCase())) {
         return city;
      }
   }

   return null;
}

type InferredWorkflow =
   | { kind: 'math'; expression: string }
   | { kind: 'weather'; query: string }
   | { kind: 'weather-advice'; query: string }
   | { kind: 'exchange-rate'; from: string; to: string }
   | { kind: 'exchange-conversion'; amount: number; from: string; to: string }
   | { kind: 'product-info'; query: string }
   | { kind: 'general-chat'; message: string };

function inferWorkflow(userInput: string): InferredWorkflow {
   if (looksLikeMath(userInput)) {
      return {
         kind: 'math',
         expression: sanitizeMathExpression(userInput),
      };
   }

   const lower = userInput.toLowerCase();

   if (
      lower.includes('smart watch s5') ||
      lower.includes('smartwatch s5') ||
      lower.includes('laptop pro') ||
      lower.includes('wireless headphones x2') ||
      lower.includes('gaming mouse g7')
   ) {
      return {
         kind: 'product-info',
         query: userInput,
      };
   }

   const currencies = extractCurrencies(userInput);
   const amount = extractAmount(userInput);

   if (currencies && amount !== null) {
      return {
         kind: 'exchange-conversion',
         amount,
         from: currencies.from,
         to: currencies.to,
      };
   }

   if (currencies && looksLikeExchangeRate(userInput)) {
      return {
         kind: 'exchange-rate',
         from: currencies.from,
         to: currencies.to,
      };
   }

   const looksLikeAdviceQuestion =
      lower.includes('should i bring') ||
      lower.includes('do i need') ||
      lower.includes('should i take') ||
      lower.includes('bring a coat') ||
      lower.includes('take a coat') ||
      lower.includes('umbrella');

   if (looksLikeWeather(userInput) && looksLikeAdviceQuestion) {
      return {
         kind: 'weather-advice',
         query: userInput,
      };
   }

   if (looksLikeWeather(userInput)) {
      return {
         kind: 'weather',
         query: userInput,
      };
   }

   return {
      kind: 'general-chat',
      message: userInput,
   };
}

function buildFallbackPlan(userInput: string): GeneratedPlan {
   const workflow = inferWorkflow(userInput);

   console.log(
      '[Router] Inferred workflow:',
      JSON.stringify(workflow, null, 2)
   );

   switch (workflow.kind) {
      case 'math':
         return {
            plan: [
               {
                  step: 1,
                  tool: 'calculateMath',
                  parameters: {
                     expression: workflow.expression,
                  },
               },
            ],
            final_answer_synthesis_required: false,
         };

      case 'weather-advice': {
         const city = extractCityFromWeatherQuery(workflow.query) ?? 'London';

         return {
            plan: [
               {
                  step: 1,
                  tool: 'getWeather',
                  parameters: {
                     location: city,
                  },
               },
               {
                  step: 2,
                  tool: 'generalChat',
                  parameters: {
                     userInput: `Weather in ${city} is {{steps.1.result.forecast}}.
Decide whether the user should bring a coat.

Rules:
- If temperature is below 18°C -> "Yes, bring a coat - it will be cold."
- If it is rainy -> "Yes, bring a coat - it will be rainy."
- If temperature is 18°C or above and not rainy -> "No, you do not need a coat - it will be warm."

Return only one sentence. No extra explanation.`,
                  },
               },
            ],
            final_answer_synthesis_required: false,
         };
      }

      case 'weather': {
         const city =
            extractCityFromWeatherQuery(workflow.query) ?? workflow.query;

         return {
            plan: [
               {
                  step: 1,
                  tool: 'getWeather',
                  parameters: {
                     location: city,
                  },
               },
            ],
            final_answer_synthesis_required: false,
         };
      }

      case 'exchange-rate':
         return {
            plan: [
               {
                  step: 1,
                  tool: 'getExchangeRate',
                  parameters: {
                     from: workflow.from,
                     to: workflow.to,
                  },
               },
            ],
            final_answer_synthesis_required: false,
         };

      case 'exchange-conversion':
         return {
            plan: [
               {
                  step: 1,
                  tool: 'getExchangeRate',
                  parameters: {
                     from: workflow.from,
                     to: workflow.to,
                  },
               },
               {
                  step: 2,
                  tool: 'calculateMath',
                  parameters: {
                     expression: `${workflow.amount} * {{steps.1.result.rate}}`,
                  },
               },
            ],
            final_answer_synthesis_required: true,
         };

      case 'product-info':
         return {
            plan: [
               {
                  step: 1,
                  tool: 'getProductInformation',
                  parameters: {
                     query: workflow.query,
                  },
               },
            ],
            final_answer_synthesis_required: false,
         };

      case 'general-chat':
      default:
         return {
            plan: [
               {
                  step: 1,
                  tool: 'generalChat',
                  parameters: {
                     userInput: workflow.message,
                  },
               },
            ],
            final_answer_synthesis_required: false,
         };
   }
}

function maybeUpgradePlan(
   userInput: string,
   plan: GeneratedPlan
): GeneratedPlan {
   const text = userInput.toLowerCase();

   const isSingleGeneralChat =
      plan?.plan?.length === 1 && plan.plan[0]?.tool === 'generalChat';

   const isSingleWeather =
      plan?.plan?.length === 1 && plan.plan[0]?.tool === 'getWeather';

   const looksLikeWeatherAdvice =
      text.includes('weather') ||
      text.includes('forecast') ||
      text.includes('rain') ||
      text.includes('coat') ||
      text.includes('umbrella') ||
      text.includes('flying to') ||
      text.includes('should i bring');

   if (looksLikeWeatherAdvice && (isSingleGeneralChat || isSingleWeather)) {
      const locationFromPlan =
         typeof plan.plan[0]?.parameters?.location === 'string'
            ? cleanExtractedLocation(String(plan.plan[0].parameters.location))
            : null;

      const city =
         extractCityFromWeatherQuery(userInput) || locationFromPlan || 'London';

      return {
         plan: [
            {
               step: 1,
               tool: 'getWeather',
               parameters: {
                  location: city,
               },
            },
            {
               step: 2,
               tool: 'generalChat',
               parameters: {
                  userInput: `Weather in ${city} is {{steps.1.result.forecast}}.
Decide whether the user should bring a coat.

Rules:
- If temperature is below 18°C -> answer: "Yes, bring a coat."
- If it is rainy -> answer: "Yes, bring a coat."
- If temperature is 18°C or above and not rainy -> answer: "No, you do not need a coat."

Return only one short sentence. No extra explanation.`,
               },
            },
         ],
         final_answer_synthesis_required: false,
      };
   }

   return plan;
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

            console.log(
               `[Router] Received user query for conversation ${conversationId}`
            );
            console.log(`[Router] User input: ${userInput}`);

            let plan: GeneratedPlan;

            try {
               const generated = await generatePlan(userInput);
               console.log(
                  '[Router] Raw generated plan:',
                  JSON.stringify(generated, null, 2)
               );

               if (generated && isValidPlan(generated)) {
                  plan = generated;
               } else {
                  logError(
                     '[Router] LLM returned invalid plan shape, using fallback plan.'
                  );
                  plan = buildFallbackPlan(userInput);
               }
            } catch (err) {
               logError(
                  '[Router] generatePlan failed, using fallback plan.',
                  err
               );
               plan = buildFallbackPlan(userInput);
            }

            plan = maybeUpgradePlan(userInput, plan);

            console.log(
               `[Router] Generated plan with ${plan.plan.length} step(s)`
            );
            console.log('[Router] Final plan:', JSON.stringify(plan, null, 2));

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
