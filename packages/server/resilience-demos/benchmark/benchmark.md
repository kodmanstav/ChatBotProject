## Extended benchmarking table (from measured runs)

| System component / scenario | Model (provider) | Avg. processing time per event (ms) | Max event rate (Events/sec) | Quality / accuracy (1-5) | Estimated cost |
|---|---:|---:|---:|:---:|---|
| Router (PlanGenerated) | Ollama (Llama3) | 38066 | 0 | 3-4 | 0 |
| Router (Fallback) | OpenAI GPT-3.5 | 9494 | 0 | 5 | $ |
| Orchestrator (ToolInvocationRequested) | Stateful Processor | 54 | 18 | N/A | 0 |
| Tool: RAG Retrieval | HF Embedding (Python) | 561 | 2 | 5 | 0 |
| Tool: LLM Infer (Ollama) | Ollama (Llama3) | 8667 | 0 | 3-4 | 0 |
| Tool: LLM Infer (OpenAI) | OpenAI GPT-3.5 | 6266 | 0 | 5 | $ |
| Aggregator (SynthesizeFinalAnswerRequested) | Stateful Processor | 12 | 83 | N/A | 0 |
| Final Synthesis | OpenAI GPT-3.5 | 1503 | 1 | 5 | $ |
| End-to-End Latency (Complex Plan) | Total over multiple events | 31599 | 0 | 5 | Total |

**Throughput (Max event rate)**: `round(1000 / average_ms)` — single client, not sustained QPS; for comparison only.

**Combined run** (17 queries per leg): (1) Ollama; Router/LLM Ollama rows exclude 3 router and 0 tool fallbacks. (2) ollama service stopped; OpenAI path. Throughput: round(1000/avg_ms). Timeouts: first leg 120s Ollama per component; fallbacks excluded from Ollama averages.