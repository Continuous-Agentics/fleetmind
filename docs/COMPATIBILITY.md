# FleetMind Compatibility

## One release, one contract

FleetMind ships its CLI, runtime bootstrap, and Terraform module from this repository. Keep the npm runtime version and module Git tag identical (apart from the tag's `v` prefix): for example runtime `1.2.1` and `git::https://github.com/Continuous-Agentics/fleetmind.git//infra/terraform/modules/fleetmind?ref=v1.2.1`. The embedded Terraform root must come from that same tag. Do not mix runtime and module releases or use the archived standalone Terraform repository.

The compatibility changes described here are source changes based on 1.2.1, **not a new release**. Use the eventual reviewed release tag for both surfaces. This change does not alter production/module defaults or template pins. Moving `latest` pins are not a tested tuple; operators must select exact matching FleetMind pins and a tested OpenClaw target before deployment.

## Declared target and evidence matrix

| Component / gate | Contract and evidence |
|---|---|
| FleetMind source base | `19cd6811593bdea6a5d146bbb8c754f1f58cc206` (1.2.1); runtime/module remain same-tag |
| OpenClaw | **2026.9.5**, verified against installed package and docs, not a claim about npm latest |
| Node | OpenClaw engine `>=24.16.0 <25 || >=26.1.0`; tested locally on **24.18.0** |
| SQLite | WAL-safe loaded library: 3.51.3+, 3.50.7+ within 3.50.x, or 3.44.6+ within 3.44.x; OpenClaw startup also probes NUL-preserving TEXT/BLOB/JSON behavior |
| Terraform / AWS provider | Existing `>=1.5` / `~>5.0` contract unchanged; no plan/apply performed |
| Core agent/provider config | Both renderer shapes validated using the actual target CLI, with bundled Anthropic/OpenAI and webhook schema; no model calls |
| Slack, search, custom plugins | Policy derivation unit-tested; actual target validation requires installed selected plugins. **Not a clean-host plugin install or channel-startup proof** |
| OpenAI API-key profile setup | Supported CLI documented below; automated fixture write was **blocked** by the installed Gateway state-path safety gate, before any credentials/config were written |
| Node 26 / fresh EC2 bootstrap / paid turns | Not executed; supported engine range is not proof of these paths |

FleetMind's own CLI `node >=20` engine is separate: commands which only render files do not start OpenClaw. `up` and config-changing `pull-self` now require the exact tested OpenClaw version before publishing a candidate. The target CLI enforces the actual linked-SQLite capability check. Missing CLI, incompatible version, unavailable configured plugin, schema/SecretRef trust failure, or invalid candidate leaves the old config and baseline unchanged.

Run narrow fixtures with `node --import tsx/esm --test --test-concurrency=1 src/test/openclaw-compat.test.ts`. With a separately installed 2026.9.5 CLI on PATH, run `npm run test:openclaw-contract`. This uses temporary config/state and no Gateway/provider calls; the core smoke deliberately excludes external channel/search/custom plugins. CI has a separate core-contract job installing that exact CLI in an isolated runner prefix. It is not a full plugin/bootstrap matrix.

## Canonical configuration and ownership

Both renderers emit keyed `agents.entries`: keys are stable IDs; there is no embedded `id` or retired `default` flag. Explicit Slack account bindings remain authoritative. A single configured agent resolves implicitly. Multi-agent renderers declare explicit ownership, with the orchestrator owning system-agent and heartbeat defaults when present; unbound multi-agent operations require a target, not ambient first-agent fallback. Multi-agent `agentDir` paths are unique because current OpenClaw rejects shared auth/session directories. Single-agent paths remain unchanged. Existing invalid shared multi-agent stores require operator credential reconciliation; this change does not copy credential databases.

Selected plugins plus known model-provider and enabled search-provider dependencies form the narrow allowlist. Custom providers must name their owning plugin in `agents.list[].plugins` (provider IDs need not equal plugin IDs). `openclaw.plugins.allow` overrides inference when explicitly authored; `openclaw.plugins.deny` always wins, including required providers. Denied entries are disabled, not silently re-enabled. A deliberately denied dependency can leave the route unavailable; FleetMind never removes the deny to make a check pass. Selected external plugins must be installed/reviewed separately.

Historical FleetMind context keys `contextLimits.toolResultMaxChars`, `compaction.reserveTokens`, `maxHistoryShare`, and `truncateAfterCompaction` are retired by 2026.9.5. Rendering stops emitting them; normalization removes those keys rather than inventing semantically different replacements. Current OpenClaw owns automatic tool-result caps. Other context/pruning/memory settings are retained.

`pull-self` normalizes legacy base, live, and incoming JSON before a recursive three-way merge. It rejects duplicate/conflicting identities and root `$include` configurations rather than guessing. Legacy implicit account routes are preserved as explicit bindings; narrower operator routes remain. Rendered agent fields and previously shipped roster membership are fleet-managed; unmanaged per-agent tools/memory settings, credentials, operator changes/deletions, and additional routing survive. Unknown baseline means existing live settings are treated as operator-owned, not erased. No credential or session database is edited.

Candidate validation runs `openclaw config validate --json` with `OPENCLAW_CONFIG_READONLY=1`, a private candidate in the real config directory, and that directory as state/plugin-discovery root. No Gateway is started and exec secret providers are not executed. Validation diagnostics are suppressed in FleetMind errors to avoid secret-value exposure. Publication uses a mode-0600 exclusive sibling file and atomic rename. Config validation precedes all workspace/baseline changes regardless of manifest order; baseline-only updates without an accompanying staged config are refused. The baseline is updated only from the successfully published incoming config, not an unrelated manifest snapshot. Config/baseline publication is **not a crash-atomic two-file transaction**. A successful sync repeated with the same inputs is stable. Local `up` uses the same merge/publication gate before workspace/env writes; `.env` and untagged workspace-file preservation beyond that gate remain separate work.

## OpenAI: API-key auth is not runtime selection

FleetMind's existing `openai/*` embedded-runtime override selects execution only. `OPENAI_API_KEY` in the service environment is **not sufficient** for current agent authentication. An ordered OpenAI API-key profile must be provisioned using OpenClaw's supported credential writer. Do not create `auth-profiles.json`, write SQLite rows, or silently use subscription credentials as fallback. This change does **not** claim fresh-host automatic OpenAI authentication is fixed.

For an operator-authorized host with the correct local Gateway/state paths, the current documented mechanism is:

1. Confirm the selected agent and installed provider plugins using `openclaw models auth list --agent <id> --provider openai --json` and `openclaw plugins list`.
2. Run `openclaw models auth paste-api-key --agent <id> --provider openai --profile-id openai:fleetmind-api`. It prompts with masking; automation can supply the key on stdin, never argv/logs. The supported writer stores key material in OpenClaw's auth store and profile metadata in config. Do not scrape or copy its storage files.
3. Select only this profile with `openclaw models auth order set --agent <id> --provider openai openai:fleetmind-api`. This supported per-agent store order takes precedence over `auth.order.openai`; check it with `order get`. Do not include OAuth/subscription profiles if API-key-only billing is intended.
4. Verify saved profile type/order with the read-only auth CLI. Saving a credential is not model/Gateway activation proof. A paid minimum-cost model turn and any Gateway refresh/restart require separate authorization.

For **fresh, disposable single-agent provisioning**, OpenClaw also documents `onboard --non-interactive --accept-risk --auth-choice openai-api-key --secret-input-mode ref` with the provider environment set. It can store a `keyRef` instead of plaintext and establishes profile/order through supported APIs. Onboarding has broader config/workspace/plugin-consent effects; it is not a safe drop-in unattended repair of an existing FleetMind host. Do not rerun it automatically on `pull-self` or bypass plugin capability consent.

**Bounded implementation blocker:** the isolated fake-key test of the supported writer correctly refused a different `OPENCLAW_STATE_DIR`/config path from the installed Gateway service, even with temporary HOME. No service or Gateway modifications were authorized, and that guard was not bypassed. Consequently an end-to-end automated auth provisioner, SecretRef persistence, and profile/order proof remain pending a disposable host without a conflicting service (plus explicit provisioning lifecycle design). The renderer/runtime comments no longer advertise env-only agent auth. Subscription provisioning remains out of scope.

## Upgrade checklist and deferred work

1. Select matching exact FleetMind runtime/module tags and the supported OpenClaw/Node tuple.
2. Run `fleetmind render --check`, then `fleetmind render`; review required provider/channel/search plugins and explicit allow/deny policy.
3. Review Terraform plans before any separately authorized apply. Stop on unexpected replacement, broad IAM expansion, or deletion. Bootstrap edits do not update running hosts.
4. Preview `pull-self` and ensure existing OpenClaw plugins/config validate. The first migration may require explicit operator ownership or auth reconciliation; failed validation preserves old config.
5. Perform disposable-host channel/auth/model acceptance before claiming fresh-bootstrap compatibility.

No NATS, updater ownership, service migration, GitHub helper, hosting/state/network redesign, deployment pin changes, or release bump is included. Root-owned installation updates and existing-host helper reconciliation remain separate operator work. Human-edited untagged skills and local `.env` preservation are not generalized by this config-only merge.

GitHub Apps remain explicitly declared per agent; `project: {}` is the legacy namespace and named Apps require `owner` and `org`. No App credentials enter Terraform. Use the existing backend/state; do not create new Terraform workspaces for an existing fleet as a compatibility workaround.
