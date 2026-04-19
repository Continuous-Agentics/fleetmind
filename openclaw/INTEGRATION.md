# OpenClaw + LangGraph Integration

How FleetMind wires OpenClaw agents to the shared LangGraph hive mind.

## Architecture

```
Human in Slack
      │
      ▼
┌─────────────────┐
│  @conductor     │  OpenClaw gateway :18789
│  orchestrator   │  SOUL: routes intelligently
│                 │  MEMORY: fleet decisions + context
└────────┬────────┘
         │ invokes LangGraph graph
         ▼
┌──────────────────────────────────┐
│  LangGraph StateGraph            │
│  orchestrator node               │
│    → routes to specialist node   │
│  frontend node / api node        │
└──────────────┬───────────────────┘
               │ shared Postgres checkpointer
               ▼
┌──────────────────────────────────┐
│  SharedState (keyed by           │
│  channel:thread_ts)              │
│  messages, context, bot_history  │
└──────┬───────────────────┬───────┘
       │                   │
       ▼                   ▼
┌────────────┐       ┌────────────┐
│  @pixel    │       │  @forge    │
│  frontend  │       │  api bot   │
│  :18790    │       │  :18791    │
└────────────┘       └────────────┘
```

## How it works

1. Human mentions @conductor (or any bot) in Slack
2. That bot's OpenClaw gateway receives the message
3. OpenClaw invokes the FleetMind LangGraph with the message + thread_id
4. LangGraph orchestrator node classifies intent and routes
5. Specialist node generates the response
6. If routed to a specialist, that bot's Slack token posts the reply
7. All state is persisted to Postgres — every bot sees full context next turn

## Shared context (hive mind)

Thread ID = `{slack_channel}:{thread_ts}`

When any agent runs, it reads:
- Full message history for the thread
- `context` dict — decisions and summaries written by any bot
- `bot_history` — which agents have participated

Write important decisions to `context` so the fleet stays aligned across turns.

## Adding a new specialist

1. `cp -r openclaw/api-bot openclaw/my-specialist`
2. Edit `workspace/SOUL.md`, `IDENTITY.md`, `AGENTS.md`
3. Add a `BaseAgent` subclass in `fleetmind/agents/`
4. Register it in `fleetmind/bots/run.py` and `fleetmind/core/graph.py`
5. Add routing keywords to `OrchestratorAgent.routing_rules`
6. Add a service in `deploy/docker-compose.yml`
7. Create a Slack app, add tokens to `.env`

## Running locally

```bash
# Start Postgres
docker compose -f deploy/docker-compose.yml up -d postgres

# Each bot in its own terminal
OPENCLAW_STATE_DIR=./openclaw/orchestrator openclaw gateway --port 18789
OPENCLAW_STATE_DIR=./openclaw/frontend-bot openclaw gateway --port 18790
OPENCLAW_STATE_DIR=./openclaw/api-bot openclaw gateway --port 18791
```
