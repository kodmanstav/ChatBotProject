import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { Kafka } from 'kafkajs';

const TOPIC = 'raw-reviews-topic';
const BROKERS = [process.env.KAFKA_BROKERS || 'localhost:9092'];

const kafka = new Kafka({
   clientId: 'reviews-producer',
   brokers: BROKERS,
});

const producer = kafka.producer();

async function sendReview(text: string): Promise<void> {
   const message = {
      reviewId: randomUUID(),
      text: text.trim(),
      timestamp: new Date().toISOString(),
   };
   await producer.send({
      topic: TOPIC,
      messages: [{ value: JSON.stringify(message) }],
   });
   console.log('Review sent successfully.');
}

async function main() {
   await producer.connect();

   const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'Review> ',
   });

   console.log(
      `Type a review and press Enter to send to ${TOPIC}. Ctrl+C to exit.\n`
   );
   rl.prompt();

   rl.on('line', async (line) => {
      const text = line.trim();
      if (!text) {
         rl.prompt();
         return;
      }
      sendReview(text).catch((err) => {
         console.error('Send error:', err);
      });
      rl.prompt();
   });

   rl.on('close', async () => {
      await producer.disconnect();
      process.exit(0);
   });
}

main().catch((err) => {
   console.error(err);
   process.exit(1);
});
