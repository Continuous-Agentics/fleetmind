# `skills.yaml` — per-bot-type skill manifest

Each bot-type directory under `openclaw/` ships a `skills.yaml` declaring the skills *required* for that bot type to stand up.

This is *data* — the renderer doesn't read it, doesn't inject anything at render time. The manifest is consumed by two CLI commands:

- **`fleetmind doctor`** — validates an existing `fleet.yaml`: for each agent, looks up the manifest matching the agent's `role`, errors if any *required* skill is missing from that agent's `skills:` list.
- **`fleetmind sync-template <bot-type>`** — scaffolds the required skills into a fresh or existing `fleet.yaml`. Idempotent — re-running adds anything missing without duplicating existing entries.

`fleetmind init` calls `sync-template` automatically so a fresh fleet.yaml starts with the right skills for each agent's role.

## Schema

```yaml
role: <pm | worker | backend-worker | frontend-worker | ...>

required:
  - name: <skill-name>
    source: <fleetmind | clawhub | private | client>
    author: <author-handle>      # required for source: clawhub
    version: <semver>            # optional pin
```

- **`role`** must match a value in the agent schema's `role` enum (`src/config/schema.ts`). One manifest per role.
- **`required`** is the minimum skill set that defines this bot type's identity. Operators *can't* sync-template a bot of this role without these skills landing in `fleet.yaml`.

### Why no `recommended` tier

An earlier draft included a `recommended:` section for skills that are "useful for many but not strictly required." That category proved fuzzy in practice (e.g. a `linear` skill only helps teams that use Linear). We dropped it — manifests express *required identity only*, and optional skills are operator choice, added directly in `fleet.yaml` per fleet.

A future *skill catalog* (separate doc) can enumerate available skills with notes on when each is useful — that's discoverability without prescription.

## Adding a new bot type

1. Create `openclaw/<new-bot-type>/skills.yaml` declaring the role + required skills.
2. Add the new role to the `role` enum in `src/config/schema.ts`.
3. Create the corresponding workspace bundle at `openclaw/<new-bot-type>/workspace/{AGENTS,SOUL,IDENTITY,PATCHES}.md`.

`fleetmind doctor` and `fleetmind render` (with skill injection) then pick it up automatically.

## Commenting out unbuilt skills

Manifests may reference skills that don't exist yet — typically when planning a slate of skills before they're built. The convention is to *comment them out* and uncomment each entry as the corresponding `openclaw/skills/<name>/SKILL.md` ships:

```yaml
required:
  - name: bot-delegation
    source: fleetmind

  # Future skills, uncomment when built:
  # - name: fleet-context
  #   source: fleetmind
```

This keeps the manifest as a forward-looking design document without breaking `fleetmind render` (which would try to inject the missing skill into `fleet.yaml`) or `fleetmind doctor` (which would error on an unresolvable skill).

## Updating an existing manifest

Adding a skill to `required` is a soft-breaking change for existing fleets — `fleetmind doctor` will flag them as missing, and operators need to run `sync-template` to absorb the change.

Removing a skill from `required` is non-breaking. Existing fleets retain the skill in their `fleet.yaml` (sync-template doesn't remove things) but new fleets won't get it scaffolded.

Document each change in the commit message and (when significant) in fleetmind's CHANGELOG.
