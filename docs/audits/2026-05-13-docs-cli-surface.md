# Docs + CLI Surface Audit — 2026-05-13

Audit scope: all markdown docs, `fleetmind --help` output for every command, and README.md
as the npm package's primary landing page. Changes applied in the same PR where noted.

---

## 1. README.md — npm package landing page

**Status: high-priority stale. Fixed in this PR.**

README.md is the only doc shipped in the npm tarball (per `package.json` `files[]`). It's the
first thing someone sees when they `npm show @continuous-agentics/fleetmind` or browse GitHub
Packages.

### Issues found and fixed

| # | Issue | Fix |
|---|-------|-----|
| 1 | **No npm auth instructions.** `fleetmind` is a private GitHub Package. README had no mention of the `read:packages` PAT or the `~/.npmrc` setup required to install it. New arrivals would get a 404 from npm with no explanation. | Added "Installation" section before Quick Start with the full auth setup. |
| 2 | **Quick Start steps 6–7 were stale / wrong.** Referenced "until deploy transport ships in issue #7" — that shipped as `push fleet`. Steps 6–7 described manual `scp` and `aws ssm send-command` workarounds that no longer apply. | Replaced with `fleetmind push fleet --restart` and a pointer to `docs/SETUP-A-FLEET.md`. |
| 3 | **Quick Start missed the Slack setup steps.** `slack manifests` + `slack discover` are mandatory before first render (render derives `wake_target_session_key` from the PM's first channel). Not mentioned at all. | Added steps 4a/4b for manifest generation and `slack discover`. |
| 4 | **CLI Reference table was incomplete.** Missing commands added in 0.4.x: `push fleet`, `pull-self`, `self-upgrade`, `secrets populate`, `slack discover`, `slack manifests`, `github-app store`, `query shipped`, `query all`, `task update`, `task unblock`, `task set-nag`. | Rewrote as grouped sections with all current commands. |
| 5 | **`fleetmind deploy` described as "push to each EC2"** in the CLI table. It has never pushed to EC2 — it renders locally to `./rendered/`. | Updated description. |
| 6 | **`task` table entry listed only `create\|ack\|ship\|block\|signoff\|abandon\|merge\|get`** — missing `update`, `unblock`, `set-nag`. | Table now lists all subcommands. |
| 7 | **`query` table entry listed only `pending\|merged\|stale`** — missing `shipped` and `all`. | Table updated. |

---

## 2. CLI `--help` output

### Fixed in this PR

| Command | Issue | Fix |
|---------|-------|-----|
| `fleetmind deploy` | Description "Provision agent workspaces and render openclaw.json" implied EC2 push. Operators familiar with `push fleet` would not realise `deploy` is local-only. | Changed to "Render per-agent workspaces + openclaw.json locally to ./rendered/ (does not push to EC2 — use `push fleet` for that)". |
| `fleetmind task` | Top-level description parenthetical enumerated subcommands but was missing `update`, `unblock` (added in 0.4.x). | Updated to complete list. |

### Issues filed for follow-up

**Issue #90 — Add usage examples to all subcommand `--help` strings**

No command has a usage-example block. Commander supports
`.addHelpText('after', ...)` for this. High-impact candidates: `push fleet`,
`task create`, `secrets populate`, `pull-self`, `self-upgrade`.

**Issue #91 — `push skill` / `push plugin`: `--config` flag should be `--fleet`**

`push skill` and `push plugin` use `-c, --config <file>` for the fleet.yaml path.
Every other command uses `--fleet`. An operator who has memorised `--fleet` will
get an unrecognised-option error on `push skill`. Breaking change — needs a semver
bump or deprecation cycle.

### Commands reviewed — no issues

The following were reviewed and are accurate:

- `fleetmind init` — description and options match behaviour
- `fleetmind diff` — thin but correct (no options)
- `fleetmind render` — correct
- `fleetmind watch` — correct
- `fleetmind status` — correct  
- `fleetmind push fleet` — description, `--no-apply` semantics, all flags accurate
- `fleetmind pull-self` — all flags accurate
- `fleetmind self-upgrade` — `--apply` dry-run semantics documented correctly; "must run as root" in description is correct
- `fleetmind secrets` (all subcommands) — accurate
- `fleetmind secrets populate` — flag help correct; `--interactive`, `--agent`, `--from` all documented
- `fleetmind slack discover` — accurate; `--force`/`--dry-run` semantics correct
- `fleetmind slack manifests` — accurate
- `fleetmind github-app store` — accurate; `--no-overwrite` documented
- `fleetmind context` (all subcommands) — accurate
- `fleetmind task` (all subcommands) — all transitions accurate after description fix above
- `fleetmind narrative <get|put>` — accurate
- `fleetmind query` (all subcommands) — accurate; `--status` filter on `all` correct
- `fleetmind agent list/info` — correct

---

## 3. Documentation files

### Fixed in this PR

| File | Issue | Fix |
|------|-------|-----|
| `openclaw/INTEGRATION.md` | Workspace path stated as `<workspace_base>/workspace-<agent_id>/` with a `workspace-` prefix that doesn't exist. `provisioner.ts` and `renderer.ts` both use `<workspace_base>/<agent_id>/` (no prefix). The stale path would cause confusion when operators look for workspace directories on EC2. | Fixed to `<workspace_base>/<agent_id>/` with correct default base `(/opt/openclaw/workspace)`. |
| `docs/MULTI-FLEET.md` | Referenced a `terraform-extras-<fleet>.tfvars` naming convention that doesn't match the actual `infra/terraform/workspaces/<fleet>.tfvars` structure in the repo. Apply commands used `--var-file=terraform-extras.tfvars` which would fail. | Updated to use the correct `workspaces/` path and two-file `-var-file` pattern matching `SETUP-A-FLEET.md`. |
| `docs/MULTI-FLEET.md` | Mentioned an org-internal AFT-vended bucket naming convention (`<org>-<account-id>-bot-content`) — an org-internal detail in a public-facing OSS-style doc. | Removed; replaced with generic "Use an existing account-level bucket or create a dedicated one." |
| `RELEASING.md` | Step 5 said to edit `infra/terraform/terraform-extras.tfvars` — that file doesn't exist. The tfvars live in `infra/terraform/workspaces/`. | Fixed to reference `infra/terraform/workspaces/`. |
| `docs/SETUP-A-FLEET.md` | Annotated example contained real Slack channel IDs (`C0B3J7CT6RJ`, `C0B3CGSNATG`) hardcoded in a public repo. | Replaced with placeholder IDs (`CXXXXXXXXXX`, `CYYYYYYYYYY`). |

### Issues filed for follow-up

**Issue #92 — gg-sandbox test docs still reference pre-push-fleet manual SCP workflow**

`docs/test/gg-sandbox/README.md` describes the "deploy-transport gap" workaround
(issue #7) even though `push fleet` shipped. Also references `terraform-extras.tfvars`
(stale name). Lower urgency (branch-local test docs) but will confuse anyone following them.

### No issues found

- `docs/SETUP-A-FLEET.md` — comprehensive and accurate end-to-end (post Slack ID fix above)
- `docs/OPERATING.md` — accurate; `push fleet` / `pull-self` workflow documented correctly
- `docs/integration/delegation.md` — accurate; WORKER_SWEEP step 4 is current
- `docs/protocol.md` — accurate; v0.4 status enum matches implementation
- `docs/GITHUB-APPS.md` — accurate; `gh-app-token` flow documented correctly
- `openclaw/README.md` — accurate; worker template descriptions current
- `openclaw/INTEGRATION.md` — accurate after workspace path fix
- `infra/terraform/README.md` — accurate; VPC endpoints section current
- `CHANGELOG.md` — matches what shipped

---

## Summary

| Category | Fixed | Filed |
|----------|-------|-------|
| README.md (npm landing) | 7 issues | — |
| CLI `--help` strings | 2 issues | 2 issues (#90, #91) |
| Docs / stale paths | 5 issues | 1 issue (#92) |
| **Total** | **14** | **3** |
