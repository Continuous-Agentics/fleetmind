# `openclaw/` — workspace contributions and skills

This directory holds source material that fleetmind composes into per-agent
workspaces at deploy time. None of these files are *the* deployed workspace —
they're the building blocks. fleetmind renders one workspace per agent and
pushes each to its respective EC2 host (each agent runs in its own gateway
on its own EC2 — see [INTEGRATION.md](INTEGRATION.md)). On the host the
workspace lives at `OPENCLAW_STATE_DIR/workspace/`.

## Layout

```
openclaw/
├── INTEGRATION.md               # how fleetmind composes the gateway from fleet.yaml
│
├── pm-bot/                      # PM-bot role template (delegation-enabled)
│   └── workspace/               # SOUL/AGENTS snippets composed into orchestrator agents
│
├── worker-bot/                  # generic worker-bot role template
│   └── workspace/               # SOUL/AGENTS snippets composed into specialist agents
│
├── backend-worker-bot/          # backend specialist role template
│   └── workspace/               # worker-bot base + backend discipline
│                                # (idempotency, timeouts, observability, schema-as-interface,
│                                #  IaC-only infra, integration tests with service stubs)
│
├── frontend-worker-bot/         # frontend specialist role template
│   └── workspace/               # worker-bot base + frontend discipline
│                                # (accessibility, bundle hygiene, component tests,
│                                #  error boundaries, UI decision docs)
│
├── skills/                      # role-aware skills shipped with fleetmind
│   ├── bot-delegation/          # PM-bot skill: emit envelope, create task, narrative,
│   │                            # query, transition lifecycle
│   └── bot-reception/           # worker-bot skill: parse envelope, ack/ship/block,
│                                # write narratives
│
├── orchestrator/                # legacy single-bot agent template (pre-PR #2)
├── frontend-bot/                # legacy single-bot agent template (pre-PR #2)
└── api-bot/                     # legacy single-bot agent template (pre-PR #2)
```

> The `orchestrator/`, `frontend-bot/`, and `api-bot/` directories predate
> the PR #2 architectural rewrite. They remain as reference material for
> single-bot setups and may be cleaned up in a future release once nothing
> internal references them.

## How composition works

`fleetmind deploy` reads `fleet.yaml` and, for each agent:

1. Picks the role template (`pm-bot` if `orchestrator: true`, otherwise
   `worker-bot`)
2. Reads the role's `workspace/` snippets (SOUL.md / AGENTS.md fragments)
3. Layers the agent's `persona.soul` block from `fleet.yaml` on top
4. Resolves the agent's skill catalog from three sources, in priority order:
   - `client` — `skills_repo` (the fleet operator's own skills repo)
   - `private` — Continuous Agentics private registry (requires
     `CA_REGISTRY_TOKEN`)
   - `clawhub` — public ClawHub skills
5. Writes the composed workspace to disk and emits the corresponding
   OpenClaw account configuration into `rendered/openclaw.json`

Skills shipped under `openclaw/skills/` (such as `bot-delegation` and
`bot-reception`) are first-party fleetmind skills and are picked up
automatically when the relevant role and `delegation.enabled` are set.

## Choosing a worker template

Three worker templates are available; pick at deploy time:

| Template dir | Use when… |
|---|---|
| `worker-bot/` | specialty not determined, or you want a clean base to overlay |
| `backend-worker-bot/` | agent will build APIs, service handlers, data models, IaC |
| `frontend-worker-bot/` | agent will build UI, components, client-side state |

Each specialty template is a superset of `worker-bot/` — same delegation
protocol, same voice discipline, plus ~20–30 lines of specialty-specific
rules. Operator selects which template seeds an agent's workspace at
deploy time via `fleet.yaml` (`agents.list[].role`).

**Long-term:** specialty-overlay merging (Option Y) would let workers
compose `worker-bot/` base + a specialty overlay without duplication.
Tracked as a future fleetmind feature.

## Adding to a role template

If you want to change behaviour for *all* PM bots in *all* fleets, edit
`pm-bot/workspace/`. If you want to change *one* fleet's PM bot, override
in that fleet's `fleet.yaml` (`persona.soul`, custom skills, etc.) — don't
fork the role template per fleet.

## Adding a new first-party skill

1. Create `openclaw/skills/<skill-name>/` with a `SKILL.md`
2. Update [`docs/integration/delegation.md`](../docs/integration/delegation.md)
   (or the relevant integration doc) so consumers know the skill exists
3. Add a CHANGELOG entry under `### Added`
