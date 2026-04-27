/**
 * Benchmark: publish UserQueryReceived, record Kafka event timestamps, aggregate
 * component latencies. See resilience-demos/benchmark/README.md
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kafka } from 'kafkajs';
import { TOPICS } from '../kafka/client';
import { safeJsonParse } from '../utils/json';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.join(__dirname, '../..');
const outDir = path.join(serverRoot, 'resilience-demos/benchmark');
const projectRoot = path.join(serverRoot, '../..');
const rootReadme = path.join(projectRoot, 'README.md');

type RunMode = 'ollama' | 'openai';

type Evt = {
   eventType: string;
   conversationId: string;
   timestamp: string;
   topic: string;
   payload: unknown;
};

type QueryCategory = 'math' | 'fx_math' | 'weather_chat' | 'rag' | 'complex';

const SUITE: { category: QueryCategory; userInput: string }[] = [
   { category: 'math', userInput: 'What is 7 plus 8?' },
   { category: 'math', userInput: 'What is 12 times 9?' },
   { category: 'math', userInput: 'What is 144 divided by 12?' },
   { category: 'math', userInput: 'What is 100 minus 37?' },
   { category: 'math', userInput: 'What is 3.5 times 2?' },
   { category: 'fx_math', userInput: 'How much is 100 USD in ILS?' },
   { category: 'fx_math', userInput: 'How much is 50 EUR in USD?' },
   { category: 'fx_math', userInput: 'Convert 200 GBP to ILS' },
   {
      category: 'weather_chat',
      userInput:
         'What is the weather in London? Should I bring a coat tomorrow?',
   },
   {
      category: 'weather_chat',
      userInput: 'What is the weather in Paris today?',
   },
   {
      category: 'weather_chat',
      userInput: 'What is the weather in Tokyo? Answer briefly.',
   },
   { category: 'rag', userInput: 'Tell me about the Smart Watch S5.' },
   { category: 'rag', userInput: 'What is the price of Laptop Pro?' },
   { category: 'rag', userInput: 'Describe the XPhone 12.' },
   {
      category: 'complex',
      userInput:
         'Convert 200 EUR to ILS, then add 5 to the result, then only output the final number.',
   },
   {
      category: 'complex',
      userInput:
         'Get the exchange rate from 100 USD to ILS, multiply the result by 2, and say the final ILS value in one sentence.',
   },
   {
      category: 'complex',
      userInput:
         'How much is 75 USD in EUR, then add 1 to the EUR amount, then output that number only?',
   },
];

const LLM_TOOLS = new Set([
   'generalChat',
   'ragGeneration',
   'orchestrationSynthesis',
]);

/** Ollama + plan + tools + synthesis; allow headroom so we do not hit 150s wall on cold runs */
const QUERY_TIMEOUT_MS = 300_000;
const BROKERS = [process.env.KAFKA_BROKERS || 'localhost:9092'];

function parseT(iso: string): number {
   return Date.parse(iso);
}

function mean(nums: number[]): number | null {
   if (nums.length === 0) return null;
   return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function round0(n: number | null): string {
   if (n == null || !Number.isFinite(n)) return 'N/A';
   return String(Math.round(n));
}

function eps(n: number | null): string {
   if (n == null || n <= 0) return 'N/A';
   return String(Math.round(1000 / n));
}

function isRecord(x: unknown): x is Record<string, unknown> {
   return x != null && typeof x === 'object' && !Array.isArray(x);
}

function extractFromEvents(
   events: Evt[],
   conversationId: string
): {
   routerMs: number | null;
   orchestratorDispatchMs: number[];
   toolRagMs: number[];
   toolLlmMs: number[];
   aggregatorMs: number | null;
   synthesisMs: number | null;
   e2eMs: number | null;
} | null {
   const mine = events.filter((e) => e.conversationId === conversationId);
   const uq = mine
      .filter((e) => e.eventType === 'UserQueryReceived')
      .map((e) => parseT(e.timestamp));
   const pg = mine
      .filter((e) => e.eventType === 'PlanGenerated')
      .map((e) => parseT(e.timestamp));
   if (uq.length === 0 || pg.length === 0) return null;
   uq.sort((a, b) => a - b);
   pg.sort((a, b) => a - b);
   const tU = uq[0]!;
   const tP = pg[0]!;
   if (!Number.isFinite(tU) || !Number.isFinite(tP)) return null;
   const routerMs = tP - tU;

   const requests = mine
      .filter(
         (e) =>
            e.eventType === 'ToolInvocationRequested' &&
            e.topic === TOPICS.TOOL_INVOCATION_REQUESTS
      )
      .map((e) => {
         if (!isRecord(e.payload)) return null;
         return {
            t: parseT(e.timestamp),
            step: e.payload.step as number,
            tool: e.payload.tool as string,
         };
      })
      .filter((x): x is { t: number; step: number; tool: string } => x != null);
   const results = mine
      .filter(
         (e) =>
            e.eventType === 'ToolInvocationResulted' &&
            e.topic === TOPICS.CONVERSATION_EVENTS
      )
      .map((e) => {
         if (!isRecord(e.payload)) return null;
         return {
            t: parseT(e.timestamp),
            step: (e.payload.step as number | undefined) ?? -1,
            tool: e.payload.tool as string,
         };
      })
      .filter(
         (x): x is { t: number; step: number; tool: string } =>
            x != null && x.step >= 0
      );
   requests.sort((a, b) => a.step - b.step);

   const findRes = (step: number, tool: string) =>
      results
         .filter((r) => r.step === step && r.tool === tool)
         .sort((a, b) => a.t - b.t)
         .pop();

   const orchestratorDispatchMs: number[] = [];
   if (requests.length > 0) {
      orchestratorDispatchMs.push(requests[0]!.t - tP);
   }
   for (let i = 1; i < requests.length; i++) {
      const prevR = findRes(requests[i - 1]!.step, requests[i - 1]!.tool);
      if (!prevR) continue;
      if (!Number.isFinite(prevR.t) || !Number.isFinite(requests[i]!.t))
         continue;
      orchestratorDispatchMs.push(requests[i]!.t - prevR.t);
   }

   const toolRagMs: number[] = [];
   const toolLlmMs: number[] = [];
   for (const req of requests) {
      const r = findRes(req.step, req.tool);
      if (!r) continue;
      const d = r.t - req.t;
      if (req.tool === 'getProductInformation') toolRagMs.push(d);
      else if (LLM_TOOLS.has(req.tool) && req.tool !== 'orchestrationSynthesis')
         toolLlmMs.push(d);
   }

   const tComp = mine
      .filter(
         (e) =>
            e.eventType === 'PlanCompleted' &&
            e.topic === TOPICS.CONVERSATION_EVENTS
      )
      .map((e) => parseT(e.timestamp));
   tComp.sort((a, b) => a - b);
   const tSyn = mine
      .filter(
         (e) =>
            e.eventType === 'SynthesizeFinalAnswerRequested' &&
            e.topic === TOPICS.USER_COMMANDS
      )
      .map((e) => parseT(e.timestamp));
   tSyn.sort((a, b) => a - b);
   const tFin = mine
      .filter(
         (e) =>
            e.eventType === 'FinalAnswerSynthesized' &&
            e.topic === TOPICS.CONVERSATION_EVENTS
      )
      .map((e) => parseT(e.timestamp));
   tFin.sort((a, b) => a - b);

   const tComp0 = tComp[0];
   const tSyn0 = tSyn[0];
   const tFin0 = tFin.length ? tFin[tFin.length - 1]! : undefined;

   let aggregatorMs: number | null = null;
   if (tComp0 != null && tSyn0 != null && tSyn0 >= tComp0)
      aggregatorMs = tSyn0 - tComp0;
   let synthesisMs: number | null = null;
   if (tSyn0 != null && tFin0 != null) synthesisMs = tFin0 - tSyn0;
   const e2eMs = tFin0 != null && Number.isFinite(tU) ? tFin0 - tU : null;
   return {
      routerMs,
      orchestratorDispatchMs,
      toolRagMs,
      toolLlmMs,
      aggregatorMs,
      synthesisMs,
      e2eMs,
   };
}

function detectRouterProvider(
   routerLog: string
): 'ollama_success' | 'openai_fallback' | 'failed' {
   if (routerLog.includes('Plan from OpenAI (fallback'))
      return 'openai_fallback';
   if (routerLog.includes('Plan from Ollama (success)'))
      return 'ollama_success';
   if (
      routerLog.includes('LLM returned invalid plan') ||
      routerLog.includes('generatePlan failed')
   )
      return 'failed';
   if (
      routerLog.includes('Ollama failed, falling back to OpenAI') &&
      routerLog.includes('Plan from OpenAI (fallback')
   )
      return 'openai_fallback';
   if (
      routerLog.includes('Ollama failed, falling back to OpenAI') &&
      !routerLog.includes('Plan from OpenAI (fallback')
   ) {
      // Still timing out to OpenAI path; treat as OpenAI, exclude from ollama row
      return 'openai_fallback';
   }
   return 'failed';
}

function detectLlmProvider(
   llmLog: string
): 'ollama_success' | 'openai_fallback' {
   if (llmLog.includes('[LLM] Ollama failed, falling back to OpenAI'))
      return 'openai_fallback';
   if (llmLog.includes('[LLM] Using Ollama')) return 'ollama_success';
   // No LLM tool; ignore
   return 'ollama_success';
}

function dockerLogs(
   serverDir: string,
   service: string,
   sinceIso: string
): string {
   try {
      return execSync(`docker compose logs ${service} --since "${sinceIso}"`, {
         cwd: serverDir,
         encoding: 'utf-8',
         maxBuffer: 30 * 1024 * 1024,
         shell: true,
      }) as string;
   } catch {
      return '';
   }
}

function dockerCompose(
   serverDir: string,
   args: string[],
   extraEnv: Record<string, string> = {}
): void {
   execSync(`docker compose ${args.join(' ')}`, {
      cwd: serverDir,
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
      shell: true,
   });
}

async function assertOllamaHasLlama3(): Promise<void> {
   const r = await fetch('http://127.0.0.1:11434/api/tags', { method: 'GET' });
   if (!r.ok) {
      throw new Error(
         `Ollama not reachable at 127.0.0.1:11434 (HTTP ${r.status}). Start the stack: docker compose up -d ollama`
      );
   }
   const j = (await r.json()) as { models?: { name?: string }[] };
   const names = (j.models ?? []).map((m) => m.name ?? '');
   const hasLlama3 = names.some((n) => n.includes('llama3'));
   if (!hasLlama3) {
      throw new Error(
         "Model 'llama3' not found. Run: docker compose exec ollama ollama pull llama3"
      );
   }
}

type QueryRecord = {
   category: QueryCategory;
   run: RunMode;
   userInput: string;
   conversationId: string;
   startIso: string;
   events: Evt[];
   metrics: NonNullable<ReturnType<typeof extractFromEvents>>;
   routerProvider:
      | 'ollama_success'
      | 'openai_fallback'
      | 'failed'
      | 'openai_run';
   llmProvider: 'ollama_success' | 'openai_fallback' | 'openai_run' | 'none';
};

type Agg = {
   routerOllama: number[];
   routerOpenai: number[];
   fallbackRouter: { conversationId: string; category: string }[];
   llmOllama: number[];
   llmOpenai: number[];
   llmOllamaFallback: { conversationId: string; category: string }[];
   orch: number[];
   rag: number[];
   agg: number[];
   synth: number[];
   e2eComplex: number[];
};

function emptyAgg(): Agg {
   return {
      routerOllama: [],
      routerOpenai: [],
      fallbackRouter: [],
      llmOllama: [],
      llmOpenai: [],
      llmOllamaFallback: [],
      orch: [],
      rag: [],
      agg: [],
      synth: [],
      e2eComplex: [],
   };
}

function recordIntoAgg(
   agg: Agg,
   r: QueryRecord,
   m: ReturnType<typeof extractFromEvents>
): void {
   if (m == null) return;
   m.orchestratorDispatchMs.forEach((d) => agg.orch.push(d));
   m.toolRagMs.forEach((d) => agg.rag.push(d));
   if (m.aggregatorMs != null) agg.agg.push(m.aggregatorMs);
   if (m.synthesisMs != null) agg.synth.push(m.synthesisMs);
   if (r.category === 'complex' && m.e2eMs != null)
      agg.e2eComplex.push(m.e2eMs);

   if (r.run === 'openai') {
      if (m.routerMs != null) agg.routerOpenai.push(m.routerMs);
      m.toolLlmMs.forEach((d) => agg.llmOpenai.push(d));
      return;
   }
   if (m.routerMs != null) {
      if (r.routerProvider === 'ollama_success')
         agg.routerOllama.push(m.routerMs);
      else if (r.routerProvider === 'openai_fallback')
         agg.fallbackRouter.push({
            conversationId: r.conversationId,
            category: r.category,
         });
   }
   if (m.toolLlmMs.length > 0) {
      if (r.llmProvider === 'ollama_success') {
         m.toolLlmMs.forEach((d) => agg.llmOllama.push(d));
      } else if (r.llmProvider === 'openai_fallback') {
         agg.llmOllamaFallback.push({
            conversationId: r.conversationId,
            category: r.category,
         });
      }
   }
}

function buildMarkdownTable(agg: Agg, postNote: string): string {
   const rO = mean(agg.routerOllama);
   const rF = mean(agg.routerOpenai);
   const o = mean(agg.orch);
   const ragM = mean(agg.rag);
   const lO = mean(agg.llmOllama);
   const lF = mean(agg.llmOpenai);
   const aM = mean(agg.agg);
   const sM = mean(agg.synth);
   const e2eM = mean(agg.e2eComplex);

   const row = (
      comp: string,
      model: string,
      t: string,
      th: string,
      q: string,
      cost: string
   ) => `| ${comp} | ${model} | ${t} | ${th} | ${q} | ${cost} |`;

   return [
      `| System component / scenario | Model (provider) | Avg. time per event (ms) | Max event rate (est. events/s) | Quality (1-5) | Est. cost |`,
      '|---|---:|---:|---:|:---:|---|',
      row(
         'Router (PlanGenerated)',
         'Ollama (llama3)',
         round0(rO),
         eps(rO),
         '3-4 (variable)',
         '0'
      ),
      row(
         'Router (OpenAI / fallback plan)',
         'OpenAI (chat)',
         round0(rF),
         eps(rF),
         '5',
         '$'
      ),
      row(
         'Orchestrator (ToolInvocationRequested…)',
         'Stateful (Node + LevelDB)',
         round0(o),
         eps(o),
         'N/A',
         '0'
      ),
      row(
         'Tool: RAG retrieval (getProductInformation)',
         'Simulated RAG (Python)',
         round0(ragM),
         eps(ragM),
         '5',
         '0'
      ),
      row(
         'Tool: LLM infer (Ollama path)',
         'Ollama (llama3)',
         round0(lO),
         eps(lO),
         '3-4 (variable)',
         '0'
      ),
      row(
         'Tool: LLM infer (OpenAI path)',
         'OpenAI (chat)',
         round0(lF),
         eps(lF),
         '5',
         '$'
      ),
      row(
         'Aggregator (SynthesizeFinalAnswerRequested…)',
         'Stateful (Node)',
         round0(aM),
         eps(aM),
         'N/A',
         '0'
      ),
      row(
         'Final synthesis (FinalAnswerSynthesized)',
         'OpenAI (synthesis path)',
         round0(sM),
         eps(sM),
         '5',
         '$'
      ),
      row(
         'End-to-end (complex 3-step plans, sample)',
         'End-to-end over Kafka',
         round0(e2eM),
         eps(e2eM),
         '5',
         'Total (API where used)'
      ),
      '',
      '**Throughput (Max event rate)**: `round(1000 / average_ms)` — single client, not sustained QPS; for comparison only.',
      '',
      postNote,
   ].join('\n');
}

async function runMode(
   mode: RunMode,
   clientSeq: string,
   suite: typeof SUITE
): Promise<{
   pathJson: string;
   pathMd: string;
   agg: Agg;
   records: QueryRecord[];
}> {
   const kafka = new Kafka({
      clientId: 'benchmark',
      brokers: BROKERS,
   });
   const groupId = `benchmark-group-${clientSeq}`;
   const eventStore = new Map<string, Evt[]>();

   const consumer = kafka.consumer({ groupId });
   await consumer.connect();
   await consumer.subscribe({
      topics: [
         TOPICS.USER_COMMANDS,
         TOPICS.CONVERSATION_EVENTS,
         TOPICS.TOOL_INVOCATION_REQUESTS,
      ],
      fromBeginning: false,
   });

   const runP = consumer.run({
      eachMessage: async ({ message, topic }) => {
         const raw = message.value?.toString();
         if (!raw) return;
         const p = safeJsonParse<unknown>(raw);
         if (p == null || !isRecord(p)) return;
         const { eventType, conversationId, timestamp, payload: pl } = p;
         if (
            typeof eventType !== 'string' ||
            typeof conversationId !== 'string' ||
            typeof timestamp !== 'string'
         )
            return;
         const ev: Evt = {
            eventType,
            conversationId,
            timestamp,
            topic,
            payload: pl,
         };
         if (!eventStore.has(conversationId))
            eventStore.set(conversationId, []);
         eventStore.get(conversationId)!.push(ev);
      },
   });
   void runP;
   // fromBeginning: false with a new group starts at the log end *after* join; wait so we do
   // not miss the first UserQuery we publish.
   await new Promise((r) => setTimeout(r, 6_000));

   const producer = kafka.producer();
   await producer.connect();
   const records: QueryRecord[] = [];
   const agg = emptyAgg();

   for (const { category, userInput } of suite) {
      const conversationId = randomUUID();
      const startIso = new Date().toISOString();
      const t0 = Date.now();
      const ev: Record<string, unknown> = {
         eventType: 'UserQueryReceived',
         conversationId,
         timestamp: startIso,
         payload: { userInput: userInput.trim() },
      };
      await producer.send({
         topic: TOPICS.USER_COMMANDS,
         messages: [{ value: JSON.stringify(ev) }],
      });
      // Cross-topic interleaving: a FinalAnswer may be processed before User/Plan; wait until
      // we have a complete extract and the final answer.
      let timedOut = false;
      for (;;) {
         if (Date.now() - t0 > QUERY_TIMEOUT_MS) {
            timedOut = true;
            break;
         }
         const all = (eventStore.get(conversationId) ?? []).slice();
         const mTry = extractFromEvents(all, conversationId);
         const hasFinal = all.some(
            (e) => e.eventType === 'FinalAnswerSynthesized'
         );
         if (mTry != null && hasFinal) {
            break;
         }
         await new Promise((r) => setTimeout(r, 100));
      }
      const all = (eventStore.get(conversationId) ?? []).slice();
      const m = extractFromEvents(all, conversationId);
      if (timedOut || m == null) {
         console.warn(
            `[Benchmark] Skipping query (timeout or incomplete events): ${category} / ${userInput.slice(0, 70)}`
         );
         continue;
      }
      const rLog = dockerLogs(serverRoot, 'router', startIso);
      const wLog = dockerLogs(serverRoot, 'llm-inference-worker', startIso);
      let routerProvider: QueryRecord['routerProvider'];
      let llmProvider: QueryRecord['llmProvider'];
      if (mode === 'openai') {
         routerProvider = 'openai_run';
         llmProvider = 'openai_run';
      } else {
         routerProvider = detectRouterProvider(rLog);
         const hadLlmTool = m.toolLlmMs.length > 0;
         if (!hadLlmTool) llmProvider = 'none';
         else
            llmProvider =
               detectLlmProvider(wLog) === 'openai_fallback'
                  ? 'openai_fallback'
                  : 'ollama_success';
      }
      const rec: QueryRecord = {
         category,
         run: mode,
         userInput,
         conversationId,
         startIso,
         events: all,
         metrics: m,
         routerProvider,
         llmProvider,
      };
      records.push(rec);
      recordIntoAgg(agg, rec, m);
   }

   await producer.disconnect();
   await consumer.disconnect();

   const outJson = path.join(outDir, `raw-${mode}.json`);
   const outMd = path.join(outDir, `summary-${mode}.md`);
   await writeFile(
      outJson,
      JSON.stringify(
         { mode, at: new Date().toISOString(), count: records.length, records },
         null,
         2
      )
   );
   const n = suite.length;
   const nfb = n > 0 ? (agg.fallbackRouter.length / n) * 100 : 0;
   const nfl = n > 0 ? (agg.llmOllamaFallback.length / n) * 100 : 0;
   const post =
      mode === 'ollama'
         ? `Ollama run: excluded **${agg.fallbackRouter.length}** router fallbacks and **${agg.llmOllamaFallback.length}** tool fallbacks from Ollama row averages (approx. ${nfb.toFixed(0)}% / ${nfl.toFixed(0)}% of queries). OLLAMA_TIMEOUT_MS was raised to 120s for router and llm-inference-worker for this run only.`
         : 'OpenAI run: ollama container was stopped. Router/LLM use the OpenAI path (no 30s Ollama wait).';

   const md = [
      '# Summary (' + mode + ')',
      '',
      buildMarkdownTable(agg, post),
      '',
   ].join('\n');
   await writeFile(outMd, md);
   return { pathJson: outJson, pathMd: outMd, agg, records };
}

function mergeAggs(oll: Agg, open: Agg): Agg {
   return {
      routerOllama: oll.routerOllama,
      routerOpenai: open.routerOpenai,
      fallbackRouter: oll.fallbackRouter,
      llmOllama: oll.llmOllama,
      llmOpenai: open.llmOpenai,
      llmOllamaFallback: oll.llmOllamaFallback,
      orch: [...oll.orch, ...open.orch],
      rag: [...oll.rag, ...open.rag],
      agg: [...oll.agg, ...open.agg],
      synth: [...oll.synth, ...open.synth],
      e2eComplex: [...oll.e2eComplex, ...open.e2eComplex],
   };
}

function parseArgs(): {
   provider: 'all' | 'ollama' | 'openai';
   updateReadme: boolean;
   maxQueries: number | null;
} {
   const argv = process.argv.slice(2);
   const p = argv
      .map((a) => {
         if (a.startsWith('--provider=')) return a.slice('--provider='.length);
         return null;
      })
      .find(Boolean);
   const maxArg = argv.find((a) => a.startsWith('--max-queries='));
   const maxQueries = maxArg
      ? (() => {
           const n = parseInt(maxArg.split('=').slice(1).join(''), 10);
           return Number.isFinite(n) && n > 0 ? n : null;
        })()
      : null;
   return {
      provider: (p as 'all' | 'ollama' | 'openai' | undefined) || 'all',
      updateReadme: argv.includes('--update-readme'),
      maxQueries,
   };
}

async function patchReadme(benchmarkBlock: string): Promise<void> {
   const mS = '<!-- BENCHMARK:START -->';
   const mE = '<!-- BENCHMARK:END -->';
   const s = await readFile(rootReadme, 'utf-8');
   if (!s.includes(mS) || !s.includes(mE)) {
      console.warn(
         '[Benchmark] Add <!-- BENCHMARK:START --> and <!-- BENCHMARK:END --> to root README, then re-run with --update-readme'
      );
      return;
   }
   const a = s.indexOf(mS);
   const b = s.indexOf(mE);
   if (a === -1 || b === -1 || a > b) return;
   const next =
      s.slice(0, a + mS.length) +
      '\n\n' +
      benchmarkBlock.trim() +
      '\n\n' +
      s.slice(b);
   await writeFile(rootReadme, next);
   console.log('[Benchmark] Patched', rootReadme);
}

async function main(): Promise<void> {
   if (
      BROKERS[0] === 'kafka:29092' ||
      (BROKERS[0] as string) === 'kafka:29092'
   ) {
      console.error(
         'KAFKA_BROKERS is kafka:29092 (in-network). From the host, use: $env:KAFKA_BROKERS=localhost:9092'
      );
      process.exit(1);
   }

   const { provider, updateReadme, maxQueries } = parseArgs();
   const suite = maxQueries != null ? SUITE.slice(0, maxQueries) : SUITE;
   if (suite.length === 0) {
      console.error('[Benchmark] No queries in suite');
      process.exit(1);
   }
   if (maxQueries != null) {
      console.log(
         `[Benchmark] Using first ${suite.length} queries (max-queries).`
      );
   }
   await mkdir(outDir, { recursive: true });
   const oldOllamaTimeout = process.env.OLLAMA_TIMEOUT_MS;
   const seq = String(Date.now());
   const restoreTimeout = (): void => {
      try {
         if (oldOllamaTimeout != null) {
            dockerCompose(
               serverRoot,
               ['up', '-d', '--no-deps', 'router', 'llm-inference-worker'],
               { OLLAMA_TIMEOUT_MS: String(oldOllamaTimeout) }
            );
         } else {
            dockerCompose(
               serverRoot,
               ['up', '-d', '--no-deps', 'router', 'llm-inference-worker'],
               { OLLAMA_TIMEOUT_MS: '30000' }
            );
         }
      } catch {
         /* */
      }
   };

   try {
      if (provider === 'all' || provider === 'ollama') {
         await assertOllamaHasLlama3();
         console.log(
            '[Benchmark] OLLAMA_TIMEOUT_MS=120000 (router + llm-inference-worker) for Ollama measurements…'
         );
         dockerCompose(
            serverRoot,
            ['up', '-d', '--no-deps', 'router', 'llm-inference-worker'],
            { OLLAMA_TIMEOUT_MS: '120000' }
         );
         await new Promise((r) => setTimeout(r, 3_000));
      }

      if (provider === 'all') {
         const r1 = await runMode('ollama', `${seq}-1`, suite);
         console.log('[Benchmark]', r1.pathJson, r1.pathMd);
         console.log(
            '[Benchmark] Stopping ollama; restoring OLLAMA_TIMEOUT; OpenAI run…'
         );
         dockerCompose(serverRoot, ['stop', 'ollama'], {});
         await new Promise((r) => setTimeout(r, 2_000));
         dockerCompose(
            serverRoot,
            ['up', '-d', '--no-deps', 'router', 'llm-inference-worker'],
            { OLLAMA_TIMEOUT_MS: oldOllamaTimeout ?? '30000' }
         );
         await new Promise((r) => setTimeout(r, 3_000));
         const r2 = await runMode('openai', `${seq}-2`, suite);
         console.log('[Benchmark]', r2.pathJson, r2.pathMd);
         const merged = mergeAggs(r1.agg, r2.agg);
         const note = [
            '**Combined run** (' +
               suite.length +
               ' queries per leg): (1) Ollama; Router/LLM Ollama rows exclude ' +
               merged.fallbackRouter.length +
               ' router and ' +
               merged.llmOllamaFallback.length +
               ' tool fallbacks. (2) ollama service stopped; OpenAI path. Throughput: round(1000/avg_ms). Timeouts: first leg 120s Ollama per component; fallbacks excluded from Ollama averages.',
         ].join(' ');
         const combined = [
            '## Extended benchmarking table (from measured runs)',
            buildMarkdownTable(merged, note),
         ].join('\n\n');
         const pathCombined = path.join(outDir, 'benchmark.md');
         await writeFile(pathCombined, combined);
         if (updateReadme) await patchReadme(combined);
         dockerCompose(serverRoot, ['start', 'ollama'], {});
         await new Promise((r) => setTimeout(r, 2_000));
      } else if (provider === 'ollama') {
         const r1 = await runMode('ollama', seq, suite);
         const note = [
            '**Ollama-only** run. Excludes **' +
               r1.agg.fallbackRouter.length +
               '** router and **' +
               r1.agg.llmOllamaFallback.length +
               '** tool fallbacks from the Ollama row averages. `OLLAMA_TIMEOUT_MS=120000` for router+llm-inference-worker for this run.',
         ].join(' ');
         const combined = [
            '## Extended benchmarking table (Ollama run only)',
            buildMarkdownTable(r1.agg, note),
         ].join('\n\n');
         await writeFile(path.join(outDir, 'benchmark.md'), combined);
         if (updateReadme) await patchReadme(combined);
      } else {
         console.log(
            '[Benchmark] Stopping ollama; OpenAI-only (configure OPENAI_API_KEY in .env)…'
         );
         dockerCompose(serverRoot, ['stop', 'ollama'], {});
         await new Promise((r) => setTimeout(r, 2_000));
         const r2 = await runMode('openai', seq, suite);
         const a = emptyAgg();
         a.routerOpenai = r2.agg.routerOpenai;
         a.llmOpenai = r2.agg.llmOpenai;
         a.orch = r2.agg.orch;
         a.rag = r2.agg.rag;
         a.agg = r2.agg.agg;
         a.synth = r2.agg.synth;
         a.e2eComplex = r2.agg.e2eComplex;
         const note =
            '**OpenAI-only** (`ollama` stopped). Ollama rows stay empty / N/A.';
         const block = '## OpenAI-only run\n\n' + buildMarkdownTable(a, note);
         await writeFile(path.join(outDir, 'benchmark.md'), block);
         if (updateReadme) await patchReadme(block);
         dockerCompose(serverRoot, ['start', 'ollama'], {});
         await new Promise((r) => setTimeout(r, 2_000));
      }
   } catch (e) {
      console.error(e);
      if (
         e instanceof Error &&
         (e.message.includes('llama3') || e.message.includes('Ollama'))
      ) {
         // fail-fast per plan
         process.exit(1);
      } else {
         process.exit(1);
      }
   } finally {
      if (provider === 'all' || provider === 'ollama') {
         restoreTimeout();
      }
   }
}

main().catch((e) => {
   console.error(e);
   process.exit(1);
});
