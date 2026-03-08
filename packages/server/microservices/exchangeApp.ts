import {
   createConsumer,
   createProducer,
   safeJsonParse,
   sendJson,
   runConsumer,
} from './shared/kafka';
import { TOPICS } from './shared/topics';

type ExchangeIntent = { currencyCode: string };

const ILS_PER: Record<string, number> = {
   USD: 3.7,
   EUR: 4.0,
   GBP: 4.6,
   JPY: 0.025,
};

const producer = await createProducer('exchange-producer');
const consumer = await createConsumer(
   'exchange-consumer',
   'exchange-consumer-intent-exchange'
);

await runConsumer(consumer, TOPICS.INTENT_EXCHANGE, async ({ message }) => {
   const userId = message.key?.toString() ?? '';
   const parsed = safeJsonParse<ExchangeIntent>(
      message.value?.toString() ?? ''
   );
   if (!userId || !parsed) return;

   const code = parsed.currencyCode.toUpperCase();
   const rate = ILS_PER[code];

   const result = rate
      ? `1 ${code} ≈ ${rate} ₪ `
      : `אין לי שער עבור ${code} (מוגדרים: ${Object.keys(ILS_PER).join(', ')})`;

   await sendJson(producer, TOPICS.APP_RESULTS, userId, {
      type: 'exchange',
      result,
   });
   console.log(`[EXCHANGE] (${userId}) ${code}`);
});
