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





# Microservices

## סקירת ה־Microservices

### userInterface.ts  
נקודת הכניסה והיציאה של המשתמש למערכת.  
**Kafka Topics:**  
- **פולט:** `user-input-events`, `user-control-events`  
- **צורך:** `bot-responses`

---

### memoryService.ts  
אחראי על ניהול ושמירת היסטוריית השיחה בקובץ.  
**Kafka Topics:**  
- **צורך:** `user-input-events`, `app-results`, `user-control-events`, `conversation-history-request`  
- **פולט:** `conversation-history-update`, `conversation-history-response`

---

### routerService.ts  
מבצע זיהוי כוונות ומנתב את הבקשות לשירות המתאים.  
**Kafka Topics:**  
- **צורך:** `user-input-events`, `conversation-history-update`  
- **פולט:** `intent-math`, `intent-weather`, `intent-exchange`, `intent-general-chat`, `conversation-history-request`

---

### mathApp.ts  
מבצע חישובים מתמטיים.  
**Kafka Topics:**  
- **צורך:** `intent-math`  
- **פולט:** `app-results`

---

### weatherApp.ts  
שולף נתוני מזג אוויר ממקור חיצוני.  
**Kafka Topics:**  
- **צורך:** `intent-weather`  
- **פולט:** `app-results`

---

### exchangeApp.ts  
מבצע המרת מטבעות באמצעות מיפוי שערים סטטי.  
**Kafka Topics:**  
- **צורך:** `intent-exchange`  
- **פולט:** `app-results`

---

### generalChatApp.ts  
שירות שיחה כללי המשתמש ב־LLM תוך הזרקת הקשר משיחת העבר.  
**Kafka Topics:**  
- **צורך:** `intent-general-chat`  
- **פולט:** `app-results`

---

### responseAggregator.ts  
מאחד את תוצאות כל שירותי ה־Worker לתשובה סופית אחת למשתמש.  
**Kafka Topics:**  
- **צורך:** `app-results`  
- **פולט:** `bot-responses`

---

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
