import path from 'node:path';
import {
   createConsumer,
   createProducer,
   safeJsonParse,
   sendJson,
   runConsumer,
} from './shared/kafka';
import { TOPICS } from './shared/topics';

type Role = 'user' | 'assistant';
type HistoryItem = { role: Role; content: string; ts: number };

type UserInputEvent = { userInput: string };
type AppResult = { type: string; result: string };
type UserControlEvent = { command: 'reset' };

type HistoryRequest = { requestId: string };
type HistoryResponse = { requestId: string; history: HistoryItem[] };

const HISTORY_PATH = path.join(import.meta.dir, 'history.json');

function now() {
   return Date.now();
}

async function loadHistory(): Promise<Record<string, HistoryItem[]>> {
   try {
      const file = Bun.file(HISTORY_PATH);
      if (!(await file.exists())) return {};
      const txt = await file.text();
      const parsed = JSON.parse(txt) as Record<string, HistoryItem[]>;
      return parsed ?? {};
   } catch {
      return {};
   }
}

async function saveHistory(data: Record<string, HistoryItem[]>) {
   await Bun.write(HISTORY_PATH, JSON.stringify(data, null, 2));
}

const producer = await createProducer('memory-producer');

const cUserInput = await createConsumer(
   'memory-consumer-input',
   'memory-consumer-user-input'
);
const cAppResults = await createConsumer(
   'memory-consumer-results',
   'memory-consumer-app-results'
);
const cControl = await createConsumer(
   'memory-consumer-control',
   'memory-consumer-control-events'
);

const cHistoryReq = await createConsumer(
   'memory-consumer-history-req',
   'memory-consumer-history-request'
);

let store: Record<string, HistoryItem[]> = await loadHistory();
console.log(
   `[MEM] loaded users: ${Object.keys(store).length} (${HISTORY_PATH})`
);

async function publishUpdate(userId: string) {
   await sendJson(producer, TOPICS.HISTORY_UPDATE, userId, {
      history: store[userId] ?? [],
   });
}

async function replyHistory(userId: string, requestId: string) {
   const history = store[userId] ?? [];
   const res: HistoryResponse = { requestId, history };
   await sendJson(producer, TOPICS.HISTORY_RESPONSE, userId, res);
   console.log(`[MEM] history response (${userId}) items=${history.length}`);
}

await runConsumer(cHistoryReq, TOPICS.HISTORY_REQUEST, async ({ message }) => {
   const userId = message.key?.toString() ?? '';
   const parsed = safeJsonParse<HistoryRequest>(
      message.value?.toString() ?? ''
   );
   if (!userId || !parsed) return;

   await replyHistory(userId, parsed.requestId);
});

await runConsumer(cUserInput, TOPICS.USER_INPUT, async ({ message }) => {
   const userId = message.key?.toString() ?? '';
   const parsed = safeJsonParse<UserInputEvent>(
      message.value?.toString() ?? ''
   );
   if (!userId || !parsed) return;

   store[userId] ??= [];
   store[userId].push({ role: 'user', content: parsed.userInput, ts: now() });

   await saveHistory(store);
   await publishUpdate(userId);

   console.log(`[MEM] +user (${userId}): ${parsed.userInput}`);
});

await runConsumer(cAppResults, TOPICS.APP_RESULTS, async ({ message }) => {
   const userId = message.key?.toString() ?? '';
   const parsed = safeJsonParse<AppResult>(message.value?.toString() ?? '');
   if (!userId || !parsed) return;

   store[userId] ??= [];
   store[userId].push({ role: 'assistant', content: parsed.result, ts: now() });

   await saveHistory(store);
   await publishUpdate(userId);

   console.log(`[MEM] +assistant (${userId}) [${parsed.type}]`);
});

await runConsumer(cControl, TOPICS.USER_CONTROL, async ({ message }) => {
   const userId = message.key?.toString() ?? '';
   const parsed = safeJsonParse<UserControlEvent>(
      message.value?.toString() ?? ''
   );
   if (!userId || !parsed) return;

   if (parsed.command === 'reset') {
      store[userId] = [];
      await saveHistory(store);
      await publishUpdate(userId);
      console.log(`[MEM] reset (${userId})`);
   }
});
