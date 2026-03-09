import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { createKafkaClient, TOPICS } from './kafka/client';
import { publishValidated } from './kafka/producer';
import { runConsumer } from './kafka/consumer';
import type { UserQueryReceivedEvent } from './types/events';
import { logInfo, logError } from './utils/logger';

const USER_COMMANDS_TOPIC = TOPICS.USER_COMMANDS;
const CONVERSATION_EVENTS_TOPIC = TOPICS.CONVERSATION_EVENTS;
const CONSUMER_GROUP = 'user-interface-events';

function isFinalAnswerEvent(
   payload: unknown
): payload is {
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

async function main(): Promise<void> {
   const kafka = createKafkaClient('user-interface');
   const producer = kafka.producer();
   await producer.connect();

   let pendingConversationId: string | null = null;
   let promptCallback: (() => void) | null = null;

   await runConsumer(kafka, {
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
            pendingConversationId = null;
            if (promptCallback) promptCallback();
         }
      },
   });

   const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'You> ',
   });

   promptCallback = () => rl.prompt();

   logInfo(
      'Subscribed to',
      CONVERSATION_EVENTS_TOPIC,
      '- waiting for FinalAnswerSynthesized. Type your message and press Enter.\n'
   );
   rl.prompt();

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
