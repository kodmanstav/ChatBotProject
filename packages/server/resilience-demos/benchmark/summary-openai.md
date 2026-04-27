# Summary (openai)

| System component / scenario | Model (provider) | Avg. time per event (ms) | Max event rate (est. events/s) | Quality (1-5) | Est. cost |
|---|---:|---:|---:|:---:|---|
| Router (PlanGenerated) | Ollama (llama3) | N/A | N/A | 3-4 (variable) | 0 |
| Router (OpenAI / fallback plan) | OpenAI (chat) | 9494 | 0 | 5 | $ |
| Orchestrator (ToolInvocationRequested…) | Stateful (Node + LevelDB) | 53 | 19 | N/A | 0 |
| Tool: RAG retrieval (getProductInformation) | Simulated RAG (Python) | 615 | 2 | 5 | 0 |
| Tool: LLM infer (Ollama path) | Ollama (llama3) | N/A | N/A | 3-4 (variable) | 0 |
| Tool: LLM infer (OpenAI path) | OpenAI (chat) | 6266 | 0 | 5 | $ |
| Aggregator (SynthesizeFinalAnswerRequested…) | Stateful (Node) | 8 | 121 | N/A | 0 |
| Final synthesis (FinalAnswerSynthesized) | OpenAI (synthesis path) | 1497 | 1 | 5 | $ |
| End-to-end (complex 3-step plans, sample) | End-to-end over Kafka | 13415 | 0 | 5 | Total (API where used) |

**Throughput (Max event rate)**: `round(1000 / average_ms)` — single client, not sustained QPS; for comparison only.

OpenAI run: ollama container was stopped. Router/LLM use the OpenAI path (no 30s Ollama wait).
