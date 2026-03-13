import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { Kafka, type Producer } from 'kafkajs';

// --- Constants ---

const OLLAMA_URL = 'http://localhost:11434/api/chat';
const OLLAMA_MODEL = process.env.OLLAMA_PII_MODEL ?? 'llama3';
const PII_SYSTEM_PROMPT =
   'You are a PII scrubber. Rewrite the input removing names and phone numbers. Output ONLY the scrubbed text.';

const KAFKA_BROKERS = [process.env.KAFKA_BROKERS || 'localhost:9092'];
const TOPIC = 'sanitized-messages';

// --- Types ---

interface OllamaMessage {
   role: 'system' | 'user' | 'assistant';
   content: string;
}

interface OllamaRequest {
   model: string;
   stream: false;
   messages: OllamaMessage[];
}

interface OllamaResponse {
   message?: { content?: string };
}

interface SanitizedMessagePayload {
   id: string;
   text: string;
   timestamp: string;
}

// --- Helpers ---

/**
 * Calls Ollama to scrub PII from text. Replaces names with [NAME] and phone numbers with [NUMBER].
 * @throws On HTTP error, network error, or invalid response (never returns raw input).
 */
async function scrubPII(text: string): Promise<string> {
   const body: OllamaRequest = {
      model: OLLAMA_MODEL,
      stream: false,
      messages: [
         { role: 'system', content: PII_SYSTEM_PROMPT },
         { role: 'user', content: text },
      ],
   };

   const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
   });

   if (!res.ok) {
      throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
   }

   let data: OllamaResponse;
   try {
      data = (await res.json()) as OllamaResponse;
   } catch {
      throw new Error('Ollama response was not valid JSON');
   }

   const content = data.message?.content;
   if (typeof content !== 'string') {
      throw new Error('Ollama response missing or invalid message.content');
   }

   return content.trim();
}

/**
 * Publishes a sanitized message to the Kafka topic.
 */
async function publishSanitizedMessage(
   producer: Producer,
   payload: SanitizedMessagePayload
): Promise<void> {
   await producer.send({
      topic: TOPIC,
      messages: [{ value: JSON.stringify(payload) }],
   });
}

/**
 * Processes one line: scrub via Ollama, then publish to Kafka. Never publishes unsanitized text.
 */
async function processLine(line: string, producer: Producer): Promise<void> {
   const trimmed = line.trim();
   if (!trimmed) return;

   const original = trimmed;

   let scrubbed: string;
   try {
      scrubbed = await scrubPII(original);
   } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : err);
      console.error('Skipping publish (Ollama failed).');
      return;
   }

   const payload: SanitizedMessagePayload = {
      id: randomUUID(),
      text: scrubbed,
      timestamp: new Date().toISOString(),
   };

   try {
      await publishSanitizedMessage(producer, payload);
   } catch (err) {
      console.error(
         'Kafka send error:',
         err instanceof Error ? err.message : err
      );
      console.error('Skipping publish (Kafka failed).');
      return;
   }

   console.log('Original:', original);
   console.log('Scrubbed:', scrubbed);
   console.log('Sent to Kafka (topic: sanitized-messages).');
}

// --- Main ---

async function main(): Promise<void> {
   const kafka = new Kafka({
      clientId: 'pii-producer',
      brokers: KAFKA_BROKERS,
   });
   const producer = kafka.producer();
   await producer.connect();

   const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'Input> ',
   });

   console.log(
      `PII producer: type a message and press Enter. Scrubbed text will be sent to "${TOPIC}". Ctrl+C to exit.\n`
   );
   rl.prompt();

   rl.on('line', async (line) => {
      await processLine(line, producer);
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
