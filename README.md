# FleetMind

Deploy and manage OpenClaw multi-agent fleets. One config file, multiple AI bots, each with its own Slack identity, persona, and skills — coordinating natively in threads.

## Architecture

```
┌──────────────────────────────────────────┐
│  FleetMind                               │
│  fleet.yaml → openclaw.json              │
│  workspace provisioning, skill lifecycle │
└────────────────────┬─────────────────────┘
                     │ generates config + workspaces
┌────────────────────▼─────────────────────┐
│  OpenClaw Gateway                        │
│  multi-agent runtime                     │
│  Conductor 🎼  Pixel 🎨  Forge ⚙️        │
│  (each a separate agent + Slack app)     │
└────────────────────┬─────────────────────┘
                     │ runs on infra from
┌────────────────────▼─────────────────────┐
│  openclaw-terraform                      │
│  EC2, IAM, networking                    │
│  consumes rendered/fleet.auto.tfvars     │
└──────────────────────────────────────────┘
```

Each agent is a fully isolated OpenClaw agent with its own workspace, Slack app, session memory, and skills. Agents communicate via OpenClaw's native `agentToAgent` messaging — Conductor delegates to Pixel or Forge, who reply directly in the Slack thread under their own bot identity.

## Quick Start

```bash
pip install fleetmind

# 1. Scaffold a new fleet
fleetmind init --name acme-fleet --client "Acme Corp"

# 2. Edit fleet.yaml — add agents, Slack tokens, skills
# 3. Store secrets
fleetmind secrets set CONDUCTOR_BOT_TOKEN xoxb-...
fleetmind secrets set CONDUCTOR_APP_TOKEN xapp-...
fleetmind secrets set PIXEL_BOT_TOKEN xoxb-...
fleetmind secrets set PIXEL_APP_TOKEN xapp-...

# 4. Preview changes
fleetmind diff

# 5. Deploy
fleetmind deploy

# 6. Restart OpenClaw gateway
openclaw gateway restart
```

## fleet.yaml Overview

```yaml
fleet:
  name: acme-fleet
  client: Acme Corp

skills_repo:
  url: https://github.com/your-org/skills-repo
  poll_interval: 60s

agents:
  defaults:
    model: anthropic/claude-sonnet-4-6

  list:
    - id: conductor
      name: Conductor
      emoji: 🎼
      orchestrator: true
      slack:
        bot_token: ${CONDUCTOR_BOT_TOKEN}
        app_token: ${CONDUCTOR_APP_TOKEN}
      agent_to_agent:
        can_send_to: [pixel, forge]

    - id: pixel
      name: Pixel
      emoji: 🎨
      skills:
        - name: coding
        - name: github
          version: "2.1.0"   # pinned
      slack:
        bot_token: ${PIXEL_BOT_TOKEN}
        app_token: ${PIXEL_APP_TOKEN}
```

See `fleet.example.yaml` for the full annotated schema.

## CLI Reference

| Command | Description |
|---|---|
| `fleetmind init` | Scaffold a new fleet.yaml |
| `fleetmind deploy` | Provision workspaces + render openclaw.json |
| `fleetmind diff` | Show what deploy would change |
| `fleetmind render` | Emit openclaw.json + tfvars without deploying |
| `fleetmind watch` | GitOps: auto-push skill updates from skills repo |
| `fleetmind status` | Show fleet + workspace status |
| `fleetmind push skill <name> --agent <id>` | Push a skill to an agent |
| `fleetmind push skill <name> --all` | Push a skill to all agents |
| `fleetmind push plugin <name> --all` | Push a plugin fleet-wide |
| `fleetmind agent list` | List all agents |
| `fleetmind agent info <id>` | Show agent details |
| `fleetmind secrets set KEY value` | Store a secret |
| `fleetmind secrets list` | List stored secret keys |
| `fleetmind secrets export` | Export secrets as shell exports |

## Skills Repo (GitOps)

FleetMind watches a versioned skills repo and automatically pushes updates:

```
your-skills-repo/
  versions.json          ← {"coding": "1.2.0", "github": "2.1.0"}
  coding/
    SKILL.md
    package.json         ← {"name": "coding", "version": "1.2.0"}
  github/
    SKILL.md
    package.json
```

```bash
# Start the watcher (runs until Ctrl+C)
fleetmind watch

# Or push a specific skill manually
fleetmind push skill coding --agent forge
fleetmind push skill github --all --version 2.1.0
```

Unpinned skills (`- name: coding`) auto-update. Pinned skills (`version: "2.1.0"`) are skipped unless `--force`.

## Terraform Integration

FleetMind generates `rendered/fleet.auto.tfvars` for the [openclaw-terraform](https://github.com/Continuous-Agentics/openclaw-terraform) repo. Terraform picks this up automatically (`.auto.tfvars` files are loaded by default).

FleetMind solves the terraform repo's TODO: *"Template it out so we can have x number of slack bots."* — define agents in `fleet.yaml`, FleetMind generates the config.

## License

MIT
