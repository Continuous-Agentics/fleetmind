# FleetMind

**Multi-agent Slack fleets backed by LangGraph.** Named, persistent, specialized bots with a shared hive mind.

## What it is

FleetMind is an opinionated framework for deploying a *fleet* of named Slack bots that:

- Each have their own Slack identity and can be addressed directly
- Share a common LangGraph state (Postgres-backed) — a genuine hive mind
- Route intelligently: an orchestrator handles most traffic, specialists handle deep dives
- Persist conversation context across sessions, across bots

## Architecture

```
Slack Channel
├── @orchestrator   ← main entry point, routes intent
├── @frontend-bot   ← specialist: UI/UX layer
└── @api-bot        ← specialist: backend APIs

         Shared LangGraph State (Postgres)
         ┌─────────────────────────────────┐
         │  messages: [...]                │
         │  active_agent: "orchestrator"   │
         │  context: { decisions, tasks }  │
         └─────────────────────────────────┘
              ↑ all bots read/write via thread_id
```

Every bot shares the same Postgres checkpointer keyed by `channel+thread_id`. When the API bot runs, it reads everything the orchestrator already wrote. That's the hive mind.

## Structure

```
fleetmind/
├── core/           # SharedState schema, graph wiring, checkpointer
├── bots/           # SlackBot base class, token management, mention routing
├── agents/         # Agent base class — extend with your tools + system prompt
├── deploy/         # Docker Compose, env templates
└── examples/       # Two-bot quickstart
```

## Quickstart

```bash
cp .env.example .env
# Fill in your Slack tokens, OpenAI key, and Postgres URL

docker compose up -d postgres
uv run python examples/two_bot_demo.py
```

## Requirements

- Python 3.11+
- PostgreSQL (for persistent shared state)
- One Slack app token per bot
- OpenAI API key (or swap in any LangChain-compatible LLM)

## Consulting use

FleetMind is designed as a consulting accelerator. The `core/` and `bots/` layers rarely change. Each client engagement lives in `agents/` — define tools, system prompts, and routing logic for their specific domain.

## License

MIT
