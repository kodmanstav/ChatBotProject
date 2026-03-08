import {
   createConsumer,
   createProducer,
   safeJsonParse,
   sendJson,
   runConsumer,
} from './shared/kafka';
import { TOPICS } from './shared/topics';

type AppResult = { type: string; result: string };

const producer = await createProducer('agg-producer');
const consumer = await createConsumer(
   'agg-consumer',
   'agg-consumer-app-results'
);

await runConsumer(consumer, TOPICS.APP_RESULTS, async ({ message }) => {
   const userId = message.key?.toString() ?? '';
   const parsed = safeJsonParse<AppResult>(message.value?.toString() ?? '');
   if (!userId || !parsed) return;

   const msg = parsed.result;
   await sendJson(producer, TOPICS.BOT_OUTPUT, userId, { message: msg });

   console.log(`[AGG] (${userId}) type=${parsed.type}`);
});
