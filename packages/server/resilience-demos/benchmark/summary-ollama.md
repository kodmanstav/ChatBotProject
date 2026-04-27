# Summary (ollama)

| System component / scenario | Model (provider) | Avg. time per event (ms) | Max event rate (est. events/s) | Quality (1-5) | Est. cost |
|---|---:|---:|---:|:---:|---|
| Router (PlanGenerated) | Ollama (llama3) | 38066 | 0 | 3-4 (variable) | 0 |
| Router (OpenAI / fallback plan) | OpenAI (chat) | N/A | N/A | 5 | $ |
| Orchestrator (ToolInvocationRequested…) | Stateful (Node + LevelDB) | 56 | 18 | N/A | 0 |
| Tool: RAG retrieval (getProductInformation) | Simulated RAG (Python) | 400 | 3 | 5 | 0 |
| Tool: LLM infer (Ollama path) | Ollama (llama3) | 8667 | 0 | 3-4 (variable) | 0 |
| Tool: LLM infer (OpenAI path) | OpenAI (chat) | N/A | N/A | 5 | $ |
| Aggregator (SynthesizeFinalAnswerRequested…) | Stateful (Node) | 17 | 61 | N/A | 0 |
| Final synthesis (FinalAnswerSynthesized) | OpenAI (synthesis path) | 1510 | 1 | 5 | $ |
| End-to-end (complex 3-step plans, sample) | End-to-end over Kafka | 58875 | 0 | 5 | Total (API where used) |

**Throughput (Max event rate)**: `round(1000 / average_ms)` — single client, not sustained QPS; for comparison only.

Ollama run: excluded **3** router fallbacks and **0** tool fallbacks from Ollama row averages (approx. 18% / 0% of queries). OLLAMA_TIMEOUT_MS was raised to 120s for router and llm-inference-worker for this run only.
