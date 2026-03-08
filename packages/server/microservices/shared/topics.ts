export const BROKERS: string[] = ['localhost:19092'];

export const TOPICS = {
   USER_INPUT: 'user-input-events',
   APPROVED_USER_INPUT: 'approved_user_input_events',
   USER_CONTROL: 'user-control-events',

   GUARDRAIL_VIOLATION: 'guardrail_violation_events',
   BOT_OUTPUT: 'bot_output_events',

   HISTORY_UPDATE: 'conversation-history-update',
   HISTORY_REQUEST: 'conversation-history-request',
   HISTORY_RESPONSE: 'conversation-history-response',
   INTENT_MATH: 'intent-math',
   INTENT_WEATHER: 'intent-weather',
   INTENT_EXCHANGE: 'intent-exchange',
   INTENT_GENERAL_CHAT: 'intent-general-chat',

   ROUTER_DECISION: 'router_decision_events',
   COT_MATH_EXPRESSION: 'cot_math_expression_events',
   LLM_RESPONSE: 'llm_response_events',
   FUNCTION_EXECUTION_REQUESTS: 'function_execution_requests',
   ERROR_EVENTS: 'error_events',

   APP_RESULTS: 'app-results',
   BOT_RESPONSES: 'bot-responses',
} as const;
