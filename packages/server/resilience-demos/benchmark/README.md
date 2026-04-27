# Benchmark outputs

The benchmark script writes files here (run from `packages/server` with Docker Compose up and `llama3` available in Ollama):

- `raw-<ollama|openai>.json` – per-conversation event timelines, deltas, and provider tags.
- `summary-<ollama|openai>.md` – one-provider summary table and any **Fallback events** (Router or LLM worker used OpenAI while Ollama was expected to succeed).
- `benchmark.md` – **combined** markdown table (used for the project root `README`).

`OLLAMA_TIMEOUT_MS` is temporarily raised to **120000** during the **Ollama** provider run (router + llm-inference-worker only), and restored after. The OpenAI run stops the `ollama` service so the stack uses OpenAI without a long Ollama wait.

See `bun run benchmark` in [packages/server/package.json](../../package.json) and the script [src/scripts/run-benchmark.ts](../../src/scripts/run-benchmark.ts).
