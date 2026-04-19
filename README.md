# FleetMind

**Multi-agent coordination platform powered by OpenClaw.**

Deploy a fleet of named, persistent, specialized AI agents in Slack — each with their own identity, memory, and skills — coordinated by a shared hive mind.

## What it is

FleetMind is the coordination layer that sits on top of OpenClaw. OpenClaw handles LLM execution, memory, and Slack connectivity for each agent. FleetMind handles:

- **Fleet definition** — one `fleet.yaml` defines your entire agent fleet
- **Routing** — the orchestrator routes messages to the right specialist
- **Shared context** — all agents read/write a common context store (the hive mind)
- **Provisioning** — `fleetmind deploy` generates all OpenClaw workspaces + Docker config

## Architecture

```
Human in Slack
      │
      ▼
┌─────────────────────┐
│  @conductor         │  OpenClaw gateway
│  (orchestrator)     │  Has its own memory, skills, soul
└──────────┬──────────┘
           │ routes via FleetRouter
    ┌──────┴───────┐
    ▼              ▼
┌────────┐    ┌────────┐
│ @pixel │    │ @forge │   Each is a full OpenClaw agent
│frontend│    │  api   │   with its own Slack token,
│  bot   │    │  bot   │   memory, and skills
└────────┘    └────────┘
    │              │
    └──────┬───────┘
           ▼
  ┌─────────────────┐
  │  Context Store  │   Shared Postgres/SQLite
  │  (hive mind)    │   All bots read/write here
  └─────────────────┘
```

OpenClaw is the LLM runtime — like Postgres is the data runtime. Your clients don't see it; they see the fleet.

## Quickstart

```bash
# Install
pip install fleetmind

# Create your fleet definition
cp fleet.example.yaml fleet.yaml
# Edit fleet.yaml with your bot names, souls, and Slack tokens

# Validate
fleetmind validate fleet.yaml

# Test routing
fleetmind route "How do I fix this React hook?" --config fleet.yaml

# Deploy (generates OpenClaw workspaces + docker-compose)
fleetmind deploy fleet.yaml --output ./my-fleet

# Run
cd my-fleet
cp .env.example .env  # fill in your tokens
docker compose up
```

## fleet.yaml

One file defines your whole fleet:

```yaml
fleet:
  name: acme-devteam

context:
  backend: postgres
  url: ${DATABASE_URL}

bots:
  - name: conductor
    role: orchestrator
    display_name: "Conductor"
    emoji: "🎼"
    soul: "You route frontend questions to @pixel, backend to @forge."
    slack:
      bot_token: ${CONDUCTOR_SLACK_TOKEN}
      ...

  - name: pixel
    role: specialist
    display_name: "Pixel"
    emoji: "🎨"
    soul: "You are the frontend specialist. React, CSS, UX."
    skills: [github, weather]
    slack:
      bot_token: ${PIXEL_SLACK_TOKEN}
      ...

routing:
  - keywords: [react, css, frontend, ui]
    to: pixel
  - keywords: [api, database, backend]
    to: forge
```

## CLI

```
fleetmind deploy    Provision OpenClaw workspaces from fleet.yaml
fleetmind validate  Validate fleet.yaml without deploying
fleetmind route     Test routing rules (dry run, no API calls)
fleetmind status    Show fleet configuration summary
```

## Adding a specialist

1. Add a bot entry to `fleet.yaml`
2. Add routing keywords
3. Run `fleetmind deploy` — new workspace generated automatically
4. Create a Slack app, add token to `.env`
5. `docker compose up`

## How OpenClaw fits in

Each bot in the fleet is a full OpenClaw agent:
- Its own Slack token and presence
- Its own `SOUL.md` (personality + expertise)
- Its own memory (`MEMORY.md`, daily notes)
- Its own skills (install via clawhub)

FleetMind generates and manages these OpenClaw workspaces from `fleet.yaml`. You define the fleet; FleetMind wires the OpenClaw plumbing.

## License

MIT
