# openclaw/ — Fleet Agent Configs

Each subdirectory is a complete OpenClaw agent workspace for one bot in the fleet.
They share state via the Postgres LangGraph checkpointer but have distinct identities,
memories, and skills.

## Structure

```
openclaw/
├── orchestrator/      ← main entry point, routes intent, talks to humans
│   └── workspace/
│       ├── SOUL.md
│       ├── IDENTITY.md
│       └── AGENTS.md
├── frontend-bot/      ← UI/UX/React/CSS specialist (Pixel)
│   └── workspace/
└── api-bot/           ← backend/API/database specialist (Forge)
    └── workspace/
```

## How agents share state

All three bots point at the same Postgres instance (via `DATABASE_URL`) and use the same
LangGraph thread IDs (keyed by Slack channel + thread timestamp). This is the hive mind:
any bot reading the shared state sees everything the others have written.

## Deploying a new specialist

1. Copy one of the agent directories as a template
2. Edit `workspace/SOUL.md` and `workspace/IDENTITY.md` for the new specialist
3. Install relevant skills into `workspace/skills/`
4. Add a new entry in `../deploy/docker-compose.yml`
5. Create a new Slack app and add its tokens to `.env`

## Running locally (no Docker)

```bash
OPENCLAW_STATE_DIR=./openclaw/orchestrator openclaw gateway --port 18789
OPENCLAW_STATE_DIR=./openclaw/frontend-bot openclaw gateway --port 18790
OPENCLAW_STATE_DIR=./openclaw/api-bot openclaw gateway --port 18791
```
