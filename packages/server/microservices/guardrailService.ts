import {
   createConsumer,
   createProducer,
   safeJsonParse,
   sendJson,
   runConsumer,
} from './shared/kafka';
import { TOPICS } from './shared/topics';

const REFUSAL_MESSAGE =
   'I cannot process this request: due to safety protocols.';

type UserInputEvent = { userInput: string };

/** Patterns that indicate politics (expand as needed). */
const POLITICS_PATTERNS = [
   /\b(?:vote|election|politic|democrat|republican|congress|senate|parliament|minister|president|prime minister)\b/i,
   /\b(?:left.?wing|right.?wing|liberal|conservative)\b/i,
   /\b(?:campaign|ballot|referendum)\b/i,
];

/** Patterns that indicate malware / malicious code requests. */
const MALWARE_PATTERNS = [
   /\b(?:malware|virus|trojan|ransomware|exploit)\b/i,
   /\b(?:write|create|generate|code).*(?:malware|virus|exploit|keylog|backdoor)\b/i,
   /\b(?:hack|hacking|exploit).*(?:code|script|tool)\b/i,
   /\b(?:keylog|keylogger|backdoor|rootkit)\b/i,
   /\b(?:steal|phish|credential.?stuffing)\b/i,
];

function detectViolation(text: string): 'politics' | 'malware' | null {
   const t = text.trim();
   if (!t) return null;
   for (const p of POLITICS_PATTERNS) {
      if (p.test(t)) return 'politics';
   }
   for (const p of MALWARE_PATTERNS) {
      if (p.test(t)) return 'malware';
   }
   return null;
}

const consumer = await createConsumer(
   'guardrail-consumer',
   'guardrail-user-input-group'
);
const producer = await createProducer('guardrail-producer');

console.log('[GUARDRAIL] starting, subscribing to', TOPICS.USER_INPUT);

await consumer.subscribe({
   topic: TOPICS.USER_INPUT,
   fromBeginning: false,
});

await consumer.run({
   eachMessage: async ({ message }) => {
      const userId = message.key?.toString() ?? '';
      const raw = message.value?.toString() ?? '';
      if (!userId || !raw) return;

      const parsed = safeJsonParse<UserInputEvent>(raw);
      const userInput = typeof parsed?.userInput === 'string' ? parsed.userInput : '';
      const reason = detectViolation(userInput);

      if (reason) {
         await sendJson(producer, TOPICS.GUARDRAIL_VIOLATION, userId, {
            reason,
            rawInput: userInput.slice(0, 1000),
            timestamp: new Date().toISOString(),
         });
         await sendJson(producer, TOPICS.BOT_OUTPUT, userId, {
            message: REFUSAL_MESSAGE,
         });
         console.log(`[GUARDRAIL] violation (${userId}) reason=${reason}`);
      } else {
         await sendJson(producer, TOPICS.APPROVED_USER_INPUT, userId, {
            userInput: userInput.trim(),
         });
         console.log(`[GUARDRAIL] pass (${userId})`);
      }
   },
});
