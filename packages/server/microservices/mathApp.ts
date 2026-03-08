import {
   createConsumer,
   createProducer,
   safeJsonParse,
   sendJson,
   runConsumer,
} from './shared/kafka';
import { TOPICS } from './shared/topics';

type MathIntent = { expression: string };

function safeEvalMath(expr: string): number | null {
   const normalized = expr.replace(/\s+/g, '').trim();
   if (!/^[0-9+\-*/().]+$/.test(normalized)) return null;

   try {
      const fn = new Function(`return (${normalized});`);
      const v = fn();
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      return v;
   } catch {
      return null;
   }
}

const producer = await createProducer('math-producer');
const intentMathConsumer = await createConsumer(
   'math-consumer',
   'math-consumer-intent-math'
);
const cotMathConsumer = await createConsumer(
   'math-consumer-cot',
   'math-consumer-cot-math'
);

async function handleMathExpression(
   userId: string,
   expression: string,
   source: string
) {
   const v = safeEvalMath(expression);
   const result =
      v === null ? `לא הצלחתי לחשב את הביטוי: ${expression}` : `${v}`;

   await sendJson(producer, TOPICS.APP_RESULTS, userId, {
      type: 'math',
      result,
   });
   console.log(`[MATH] (${userId}) [${source}] ${expression} = ${result}`);
}

await Promise.all([
   runConsumer(intentMathConsumer, TOPICS.INTENT_MATH, async ({ message }) => {
      const userId = message.key?.toString() ?? '';
      const parsed = safeJsonParse<MathIntent>(message.value?.toString() ?? '');
      if (!userId || !parsed) return;

      await handleMathExpression(
         userId,
         parsed.expression?.trim() ?? '',
         'intent-math'
      );
   }),

   runConsumer(cotMathConsumer, TOPICS.COT_MATH_EXPRESSION, async ({ message }) => {
      const userId = message.key?.toString() ?? '';
      const expression = message.value?.toString()?.trim() ?? '';
      if (!userId || !expression) return;

      await handleMathExpression(userId, expression, 'cot');
   }),
]);
