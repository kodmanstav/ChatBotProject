# Resilience Demos - Submission Logs

This folder contains **real logs captured from actual runs** of Docker Compose (`packages/server/docker-compose.yml`) for the three required resilience scenarios.

| File | Scenario |
|------|----------|
| [scenario-1-worker-crash.log](./scenario-1-worker-crash.log) | Python `rag-worker` crash/unavailability during a plan |
| [scenario-2-orchestrator-crash.log](./scenario-2-orchestrator-crash.log) | `orchestrator` crash during a plan and resume from `conversation-events` + persisted state |
| [scenario-3-duplicate-events.log](./scenario-3-duplicate-events.log) | Duplicate `ToolInvocationRequested` event -> idempotency in `math-worker` |

Each `.log` file includes lines that start with `#` as reviewer notes. All other lines are raw `docker compose logs` output (`service | message`).

## Additional Demo Logs

The following files were added for extra presentation scenarios (complex orchestration + RAG):

| File | Scenario |
|------|----------|
| [orchestration-complex-1.log](./orchestration-complex-1.log) | 3-step chain: `getExchangeRate` -> `calculateMath` -> `calculateMath` |
| [orchestration-complex-2.log](./orchestration-complex-2.log) | 3-step chain: `getWeather` -> `getExchangeRate` -> `calculateMath` |
| [orchestration-complex-3.log](./orchestration-complex-3.log) | 3-step chain: `getProductInformation` -> `getExchangeRate` -> `calculateMath` |
| [rag-scenario-1.log](./rag-scenario-1.log) | RAG catalog retrieval (`answer_type: catalog`) |
| [rag-scenario-2.log](./rag-scenario-2.log) | RAG price retrieval + follow-up math aggregation (`answer_type: catalog_field`) |

---

## Environment

```powershell
Set-Location "path\to\ChatBotProjectKafka\packages\server"
docker compose ps   # kafka, orchestrator, rag-worker, math-worker, exchange-rate-worker, router, ... should be Up
```

Message flow reminder:

`user-commands` -> Router -> `conversation-events` (`PlanGenerated`) -> Orchestrator -> `tool-invocation-requests` -> Workers -> `conversation-events` (`ToolInvocationResulted`).

---

## Scenario 1 - Worker (RAG) unavailable, then recovery

**Example conversationId in log:** `813a8094-c8c1-48b1-8dcc-457d82087e64`

**What was demonstrated:** `rag-worker` was stopped **before** publishing the user query. The orchestrator dispatched `getProductInformation`, but no worker consumed it until `rag-worker` was started again. There is a clear time gap (~54 seconds) between `Dispatched step 1` and `[RAG Worker] Received ToolInvocationRequested`, proving the plan was waiting on worker availability.

**Relevant code:** `rag-retriever-worker.py` uses `enable_auto_commit=False` and commits only after successful publish (prevents data loss and enables replay after failure).

**How to replay (PowerShell):**

```powershell
docker compose stop rag-worker
Start-Sleep -Seconds 2
# Publish UserQueryReceived to user-commands (single-line JSON) via kafka-console-producer
docker compose start rag-worker
```

**Key proof lines:** gap between `22:47:24.747` (Dispatched) and `22:48:19.146` (RAG Received), followed by `Plan resuming` and `Plan completed`.

---

## Scenario 2 - Orchestrator killed mid-plan and resumed after restart

**Example conversationId in log:** `e52e6399-d264-4659-ac1f-cc4858a816e1`

**What was demonstrated:** to create a stable crash window (without the orchestrator finishing too quickly), `exchange-rate-worker` was stopped before publishing the query. The orchestrator dispatched `getExchangeRate`, then the orchestrator process was killed with `SIGKILL`. After restart, log shows `Started. State store ready`, then the orchestrator consumes pending `ToolInvocationResulted` from `conversation-events` and continues (`Plan resuming`, `Dispatching step 2`, ...).

**State storage:** LevelDB under `packages/server/.orchestrator-state/` (`ORCHESTRATOR_STATE_PATH`), see [state-store.service.ts](../src/services/state-store.service.ts).

**How to replay (PowerShell):**

```powershell
docker compose stop exchange-rate-worker
# Publish UserQueryReceived (query containing currency conversion + math)
# Wait for "Dispatched step 1 (getExchangeRate)"
docker compose kill -s SIGKILL orchestrator
Start-Sleep -Seconds 2
docker compose start exchange-rate-worker
Start-Sleep -Seconds 8
docker compose start orchestrator
```

**Key proof lines:** `Dispatched step 1` -> `Started. State store ready` (after restart) -> `Applying result` / `Plan resuming` -> `Plan completed`.

---

## Scenario 3 - Duplicate event (`ToolInvocationRequested`)

**Example conversationId in log:** `d41e8a57-950d-49c6-afed-0ad45940a7c0`

**What was demonstrated:** after a normal `calculateMath` completion, the exact same `ToolInvocationRequested` payload was read back from Kafka (`kafka-console-consumer` on `tool-invocation-requests`) and re-published with `kafka-console-producer`. `math-worker` logged `Skipping duplicate`, proving idempotency. See [idempotency.ts](../src/utils/idempotency.ts) and [math-worker.ts](../src/node/math-worker.ts).

**How to replay (PowerShell):**

```powershell
# After a normal run of "What is 7 plus 8?" and Plan completed:
docker compose exec -T kafka sh -c "kafka-console-consumer --bootstrap-server kafka:29092 --topic tool-invocation-requests --from-beginning --timeout-ms 120000 --max-messages 8000" `
  | Select-String "YOUR_CONVERSATION_ID" | Select-String "calculateMath" | Select-Object -Last 1
# Copy the full JSON line and publish it back:
docker compose exec -T kafka kafka-console-producer --bootstrap-server kafka:29092 --topic tool-invocation-requests
# Paste line + Enter, then exit producer (Ctrl+Z if needed)
docker compose logs math-worker --tail 30
```

**Key proof lines:** first run includes `Published ToolInvocationResulted`, then after replay: `Skipping duplicate` and no second `Published ToolInvocationResulted`.

---

## Submission Notes

1. If the lecturer asks for **CLI** instead of direct Kafka publish, run `docker compose --profile cli run --rm -T user-interface` and type the same query. The Kafka flow is equivalent to publishing `UserQueryReceived`.
2. Scenario 2 is timing-sensitive. The `stop exchange-rate-worker` + `SIGKILL orchestrator` sequence makes the demo deterministic and clean.
3. `logExecution` in [logger.ts](../src/utils/logger.ts) is disabled, so evidence is based on service `console.log` output shown in these files.
