import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import {
   createConsumer,
   createProducer,
   safeJsonParse,
   sendJson,
   runConsumer,
} from './shared/kafka';
import { TOPICS } from './shared/topics';

type BotResponse = { message: string };
type UserInputEvent = { userInput: string };
type UserControlEvent = { command: 'reset' };

type Role = 'user' | 'assistant';
type HistoryItem = { role: Role; content: string; ts: number };
type HistoryRequest = { requestId: string };
type HistoryResponse = { requestId: string; history: HistoryItem[] };

const userId = process.env.USER_ID ?? 'demo-user';

const requestId = randomUUID();

console.log(`[UI] userId = ${userId}`);
console.log(
   `[UI] Type messages. Use /reset to clear history. Ctrl+C to exit.\n`
);

const producer = await createProducer('ui-producer');

const cBot = await createConsumer(
   'ui-consumer-bot',
   'ui-consumer-bot-output'
);
const cHist = await createConsumer(
   'ui-consumer-hist',
   'ui-consumer-history-response'
);

const rl = readline.createInterface({
   input: process.stdin,
   output: process.stdout,
   prompt: '> ',
});

function redrawPrompt() {
   readline.clearLine(process.stdout, 0);
   readline.cursorTo(process.stdout, 0);
   rl.prompt(true);
}

let welcomeDone = false;

function finishWelcome() {
   if (welcomeDone) return;
   welcomeDone = true;
   redrawPrompt();
}

await runConsumer(cHist, TOPICS.HISTORY_RESPONSE, async ({ message }) => {
   const key = message.key?.toString() ?? '';
   if (key !== userId) return;

   const parsed = safeJsonParse<HistoryResponse>(
      message.value?.toString() ?? ''
   );
   if (!parsed) return;

   if (parsed.requestId !== requestId) return;

   const hasHistory = (parsed.history?.length ?? 0) > 0;

   if (hasHistory) {
      process.stdout.write(
         '\nbot: Welcome back. Resuming your previous conversation.\n'
      );
   } else {
      process.stdout.write(
         '\nbot: Hello. This is a new conversation. How can I help you?\n'
      );
   }

   finishWelcome();
});

setTimeout(() => {
   if (!welcomeDone) {
      process.stdout.write(
         '\nbot: Unable to load conversation history. Continuing with a new session.\n'
      );
      finishWelcome();
   }
}, 2000);

const req: HistoryRequest = { requestId };
await sendJson(producer, TOPICS.HISTORY_REQUEST, userId, req);
process.stdout.write('[UI] requesting history...\n');

await runConsumer(cBot, TOPICS.BOT_OUTPUT, async ({ message }) => {
   const key = message.key?.toString() ?? '';
   if (key !== userId) return;

   const parsed = safeJsonParse<BotResponse>(message.value?.toString() ?? '');
   if (!parsed) return;

   process.stdout.write(`\nbot: ${parsed.message}\n`);
   redrawPrompt();
});

rl.on('line', async (line) => {
   if (!welcomeDone) {
      redrawPrompt();
      return;
   }

   const text = line.trim();
   if (!text) {
      redrawPrompt();
      return;
   }

   if (text === '/reset') {
      const value: UserControlEvent = { command: 'reset' };
      await sendJson(producer, TOPICS.USER_CONTROL, userId, value);
      process.stdout.write('[UI] reset command sent\n');
      redrawPrompt();
      return;
   }

   const value: UserInputEvent = { userInput: text };
   await sendJson(producer, TOPICS.USER_INPUT, userId, value);
   redrawPrompt();
});

rl.on('close', async () => {
   process.stdout.write('\n[UI] goodbye\n');
   process.exit(0);
});
