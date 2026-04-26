# server

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.3. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.





# Kafka event-driven agent (Parts A & B)

## 1. Start Kafka

From the `packages/server` directory:

```bash
docker compose up -d
```

Kafka will be available at **localhost:9092**. The init container creates these topics automatically:

- `user-commands` – user CLI commands (e.g. UserQueryReceived)
- `conversation-events` – agent events (PlanGenerated, ToolInvocationResulted, PlanStepCompleted, FinalAnswerSynthesized)
- `tool-invocation-requests` – requests for tool execution
- `dead-letter-queue` – invalid or failed events

## 2. Create topics manually (if auto-creation fails)

Run inside the Kafka container:

```bash
docker compose exec kafka kafka-topics --bootstrap-server localhost:9092 --create --if-not-exists --topic user-commands --partitions 1 --replication-factor 1
docker compose exec kafka kafka-topics --bootstrap-server localhost:9092 --create --if-not-exists --topic conversation-events --partitions 1 --replication-factor 1
docker compose exec kafka kafka-topics --bootstrap-server localhost:9092 --create --if-not-exists --topic tool-invocation-requests --partitions 1 --replication-factor 1
docker compose exec kafka kafka-topics --bootstrap-server localhost:9092 --create --if-not-exists --topic dead-letter-queue --partitions 1 --replication-factor 1
```

## 3. Run the Node.js CLI (user interface)

Install dependencies (if not already), then run the CLI:

```bash
bun install
bun run user-interface
```

The CLI will:

- Prompt you for input (`You>`).
- Publish each line as a **UserQueryReceived** command to `user-commands` (validated with JSON schema).
- Consume from `conversation-events` and wait for **FinalAnswerSynthesized** with the same `conversationId`.
- Print `Assistant: <finalAnswer>` when that event arrives.

To see answers, another service must consume `user-commands` and produce **FinalAnswerSynthesized** events to `conversation-events` (e.g. a future agent worker).

## 4. Topic usage summary

| Topic | Purpose |
|-------|---------|
| `user-commands` | Commands from the user CLI (UserQueryReceived). Consumed by the agent/orchestrator. |
| `conversation-events` | Agent lifecycle events (plan, tool results, steps, final answer). Consumed by the CLI and other subscribers. |
| `tool-invocation-requests` | Requests to run tools (e.g. weather, search). Used by the agent pipeline. |
| `dead-letter-queue` | Events that failed schema validation (or that you choose to divert here). |

---
