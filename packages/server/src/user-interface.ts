import readline from 'node:readline';
import path from 'node:path';
import {
   readFileSync,
   writeFileSync,
   existsSync,
   unlinkSync,
   mkdirSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { logLevel } from 'kafkajs';
import { createKafkaClient, TOPICS } from './kafka/client';
import { publishValidated } from './kafka/producer';
import { runConsumer } from './kafka/consumer';
import type { UserQueryReceivedEvent } from './types/events';
import { logInfo, logError } from './utils/logger';
import { safeJsonParse } from './utils/json';

const USER_COMMANDS_TOPIC = TOPICS.USER_COMMANDS;
const CONVERSATION_EVENTS_TOPIC = TOPICS.CONVERSATION_EVENTS;
const CONSUMER_GROUP = 'user-interface-events';

const PENDING_FILE =
   process.env.PENDING_CONVERSATION_FILE ??
   path.join(process.cwd(), '.pending-conversation.json');
const PENDING_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const RECOVERY_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const RECOVERY_SCAN_TIMEOUT_MS = 30 * 1000; // 30s scan from beginning

function readPending(): { conversationId: string } | null {
   if (!existsSync(PENDING_FILE)) return null;
   try {
      const raw = readFileSync(PENDING_FILE, 'utf-8');
      const data = JSON.parse(raw) as {
         conversationId: string;
         timestamp: string;
      };
      if (!data.conversationId || !data.timestamp) return null;
      const age = Date.now() - new Date(data.timestamp).getTime();
      if (age > PENDING_MAX_AGE_MS) {
         unlinkSync(PENDING_FILE);
         return null;
      }
      return { conversationId: data.conversationId };
   } catch {
      try {
         unlinkSync(PENDING_FILE);
      } catch {}
      return null;
   }
}

function writePending(conversationId: string): void {
   const dir = path.dirname(PENDING_FILE);
   if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
   }
   writeFileSync(
      PENDING_FILE,
      JSON.stringify({
         conversationId,
         timestamp: new Date().toISOString(),
      }),
      'utf-8'
   );
}

function clearPending(): void {
   try {
      if (existsSync(PENDING_FILE)) unlinkSync(PENDING_FILE);
   } catch {}
}

function isFinalAnswerEvent(payload: unknown): payload is {
   eventType: 'FinalAnswerSynthesized';
   conversationId: string;
   payload: { finalAnswer: string };
} {
   if (payload == null || typeof payload !== 'object') return false;
   const o = payload as Record<string, unknown>;
   if (o.eventType !== 'FinalAnswerSynthesized') return false;
   if (typeof o.conversationId !== 'string') return false;
   if (o.payload == null || typeof o.payload !== 'object') return false;
   const p = o.payload as Record<string, unknown>;
   return typeof p.finalAnswer === 'string';
}

/**
 * Scan conversation-events from the beginning to find FinalAnswerSynthesized
 * for the given conversationId (used when reopening CLI after closing before answer).
 */
async function recoveryScan(
   conversationId: string
): Promise<{ found: true; answer: string } | { found: false }> {
   const kafka = createKafkaClient('user-interface-recovery', {
      logLevel: logLevel.NOTHING,
   });
   const consumer = kafka.consumer({
      groupId: `user-interface-recovery-${Date.now()}`,
   });
   await consumer.connect();
   await consumer.subscribe({
      topic: CONVERSATION_EVENTS_TOPIC,
      fromBeginning: true,
   });

   return new Promise<{ found: true; answer: string } | { found: false }>(
      (resolve) => {
         let settled = false;
         const done = (
            result: { found: true; answer: string } | { found: false }
         ) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            consumer.disconnect().catch(() => {});
            resolve(result);
         };

         const timeout = setTimeout(() => {
            done({ found: false });
         }, RECOVERY_SCAN_TIMEOUT_MS);

         consumer
            .run({
               eachMessage: async ({ message }) => {
                  const raw = message.value?.toString();
                  if (!raw) return;
                  const payload = safeJsonParse<unknown>(raw);
                  if (payload == null) return;
                  if (
                     isFinalAnswerEvent(payload) &&
                     payload.conversationId === conversationId
                  ) {
                     done({
                        found: true,
                        answer: payload.payload.finalAnswer,
                     });
                  }
               },
            })
            .catch((err) => {
               clearTimeout(timeout);
               logError('Recovery scan consumer error:', err);
               done({ found: false });
            });
      }
   );
}

async function main(): Promise<void> {
   const kafka = createKafkaClient('user-interface', {
      logLevel: logLevel.NOTHING,
   });
   const producer = kafka.producer();
   await producer.connect();

   let pendingConversationId: string | null = null;
   let promptCallback: (() => void) | null = null;

   const pending = readPending();
   if (pending) {
      logInfo(
         'Recovery: scanning conversation-events for answer (',
         RECOVERY_SCAN_TIMEOUT_MS / 1000,
         's)...'
      );
      const scanResult = await recoveryScan(pending.conversationId);
      if (scanResult.found) {
         console.log(`\nAssistant: ${scanResult.answer}\n`);
         clearPending();
         pendingConversationId = null;
      } else {
         pendingConversationId = pending.conversationId;
         logInfo(
            'Recovery: no answer in recent history; waiting for live answer (timeout ',
            RECOVERY_TIMEOUT_MS / 1000,
            's).\n'
         );
      }
   }

   runConsumer(kafka, {
      topic: CONVERSATION_EVENTS_TOPIC,
      groupId: CONSUMER_GROUP,
      onMessage: (payload) => {
         if (!isFinalAnswerEvent(payload)) return;
         if (
            pendingConversationId !== null &&
            payload.conversationId === pendingConversationId
         ) {
            const answer = payload.payload.finalAnswer;
            console.log(`\nAssistant: ${answer}\n`);
            clearPending();
            pendingConversationId = null;
            if (promptCallback) promptCallback();
         }
      },
   }).catch((err) => {
      logError('Consumer error:', err);
   });

   const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'You> ',
   });

   promptCallback = () => rl.prompt();

   if (pendingConversationId !== null) {
      setTimeout(() => {
         if (pendingConversationId !== null) {
            clearPending();
            pendingConversationId = null;
            logInfo(
               'Recovery timeout – no answer received. You can type a new message.\n'
            );
            if (promptCallback) promptCallback();
         }
      }, RECOVERY_TIMEOUT_MS);
   } else {
      logInfo(
         'Subscribed to',
         CONVERSATION_EVENTS_TOPIC,
         '- waiting for FinalAnswerSynthesized. Type your message and press Enter.\n'
      );
      rl.prompt();
   }

   rl.on('line', async (line) => {
      const userInput = line.trim();
      if (!userInput) {
         rl.prompt();
         return;
      }
      if (pendingConversationId !== null) {
         logInfo('Still waiting for the previous answer. Ignoring input.');
         rl.prompt();
         return;
      }
      const conversationId = randomUUID();
      const timestamp = new Date().toISOString();
      const command: UserQueryReceivedEvent = {
         eventType: 'UserQueryReceived',
         conversationId,
         timestamp,
         payload: { userInput },
      };
      const ok = await publishValidated(producer, {
         topic: USER_COMMANDS_TOPIC,
         value: command,
         sendToDlqOnValidationFailure: true,
      });
      if (!ok) {
         logError(
            'Failed to publish UserQueryReceived (validation or send failed).'
         );
         rl.prompt();
         return;
      }
      pendingConversationId = conversationId;
      writePending(conversationId);
      logInfo(
         'Sent command for conversation',
         conversationId,
         '- waiting for final answer...'
      );
      // Do not call rl.prompt() here; prompt after FinalAnswerSynthesized in consumer
   });

   rl.on('close', async () => {
      await producer.disconnect();
      process.exit(0);
   });
}

main().catch((err) => {
   logError('Fatal:', err);
   process.exit(1);
});
