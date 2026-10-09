# `skills.yaml` — per-bot-type skill manifest

Each bot-type directory under `openclaw/` ships a `skills.yaml` declaring the skills *required* for that bot type to stand up.

This is policy data consumed by FleetMind's operator commands:

- **`fleetmind doctor`** — validates an existing `fleet.yaml`: for each agent, looks up the manifest matching the agent's `role`, evaluates entry conditions against fleet configuration, and errors if any active required skill is missing.
- **`fleetmind render`** — uses the same active requirement set. `--check` is read-only; normal render appends missing active skills before producing outputs.
- **`fleetmind sync-template <bot-type>`** — scaffolds manifest skills for template creation. Idempotent — re-running adds anything missing without duplicating existing entries.

`fleetmind init` calls `sync-template` automatically so a fresh fleet.yaml starts with the right skills for each agent's role.

## Schema

```yaml
role: <pm | worker | backend-worker | frontend-worker | ...>

required:
  - name: <skill-name>
    source: <fleetmind | clawhub | private | client>
    author: <author-handle>      # required for source: clawhub
    version: <semver>            # optional pin
    when: delegation-enabled     # optional feature condition
```

- **`role`** must match a value in the agent schema's `role` enum (`src/config/schema.ts`). One manifest per role.
- **`required`** is the minimum skill set that defines this bot type's identity. An entry without `when` is unconditional.
- **`when: delegation-enabled`** activates the entry only when `delegation.enabled: true`. Use it for delegation protocol skills (`bot-delegation`, `bot-reception`, and `worker-self-start`), not for unrelated role competence such as `structured-pr-review`.

Inactive requirements are excluded consistently from missing-skill checks, source-mismatch warnings, render mutation, and doctor totals. Existing skills are never removed when a condition becomes inactive.

Manifests express *required identity only*. Optional skills are operator choice, added per-fleet via `fleetmind skill add` or by editing `fleet.yaml` directly.

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

Adding an unconditional skill to `required` is a soft-breaking change for existing fleets — `fleetmind doctor` will flag it as missing, and operators need to run `fleetmind render` or `sync-template` to absorb the change. A conditional skill affects only fleets where its condition is active.

Removing a skill from `required` is non-breaking. Existing fleets retain the skill in their `fleet.yaml` (sync-template doesn't remove things) but new fleets won't get it scaffolded.

Document each change in the commit message and (when significant) in fleetmind's CHANGELOG.
