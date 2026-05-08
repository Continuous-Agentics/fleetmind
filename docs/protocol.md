# Task Ledger Protocol — v0.4

> **Status:** v0.4 (status enum: `accepted` = worker ack; `signed_off` = human approval)
> **Companion:** `docs/integration/delegation.md` — how to enable delegation in a fleet

## Why this exists

When a PM bot delegates a task to a worker bot, the *what was done + what was
learned* should be captured in a durable, queryable place. Future delegations
can lean on prior task output instead of starting cold.

This is **deliberately narrow**: the task ledger is one thing — "what got done,
what was learned, by whom, when." Not a project manager, not a knowledge graph.

## Design tenets

1. **Narrow > bundled.** Task ledger = record-of-action. Not a journal.
2. **Schema is interface.** Versioned schema (`v: 0.2`) for both DDB items and S3 markdown frontmatter.
3. **Ship small, learn from real use.** No embeddings, no summarization. Write/read first.
4. **Bots write only what they did, not what they think.**
5. **Tracker-agnostic.** External trackers (Linear, Jira, GitHub Issues) are referenced by URL when relevant, not required.
6. **Right substrate per data shape.** Structured state (status, timestamps, lifecycle, IDs) → DynamoDB. Free-form narrative content (task descriptions, Learned sections) → S3.

## Substrate split

| Data type | Substrate | Why |
|---|---|---|
| Structured task state | DynamoDB | Conditional writes, indexed queries, change streams, TTL |
| Narrative task content (`.md`) | S3 | Right shape for blobs; auditable; readable by non-bot consumers |
| Wake signal | DynamoDB Streams → EventBridge Pipe → SSM Run Command | Terminal status transition triggers PM bot wake |

## DynamoDB schema

**Table:** `{name_prefix}tasks` (default: `fleetmind-tasks`)

- Billing: pay-per-request
- Streams: enabled, `NEW_AND_OLD_IMAGES`
- TTL: `expires_at` attribute (epoch seconds; set to `delegated_at + 365d`)
- Encryption: AWS-managed key
- Deletion protection: enabled (both DDB-native and Terraform `prevent_destroy`)

### Primary key

```
PK: TASK#<task_id>
```

`task_id` is an 8-char lowercase hex string generated at delegation time by the PM bot.

### Attributes

| Attribute | Type | Required | Description |
|---|---|---|---|
| `PK` | S | yes | `TASK#<task_id>` |
| `task_id` | S | yes | 8-char hex |
| `v` | S | yes | Schema version (`"0.2"`) |
| `project` | S | yes | Project slug (e.g. `website-rewrite`) |
| `status` | S | yes | See Status enum below |
| `GSI1PK` | S | yes | `PROJECT#<slug>#STATUS#<status>` |
| `GSI2PK` | S | yes | `STATUS#<status>` |
| `delegated_by` | S | yes | PM bot identifier |
| `worker` | S | yes | Worker bot identifier |
| `delegated_at` | S | yes | ISO 8601 timestamp |
| `accepted_at` | S | no | Set when worker acks |
| `shipped_at` | S | no | Set when worker ships |
| `signed_off_at` | S | no | Set when human signs off |
| `merged_at` | S | no | Set when artifact merges |
| `blocked_at` | S | no | Set on blocked |
| `abandoned_at` | S | no | Set on abandoned |
| `lifecycle` | S | yes | `requires-human-signoff` \| `shipped-is-done` |
| `definition_of_done` | S | yes | One-paragraph DoD from delegation envelope |
| `delegation_thread` | S | yes | Coordination channel thread URL |
| `delegation_envelope_ts` | S | yes | Envelope message ID |
| `tracker_link` | S | no | External tracker URL (or null) |
| `task_s3_key` | S | yes | S3 path to narrative `.md` |
| `expires_at` | N | yes | TTL epoch seconds |

### Status enum

`delegated` → `accepted` → `shipped` → `signed_off` → `merged`

Side transitions: any non-terminal state → `blocked` or `abandoned`

| Status | Who sets it | Meaning |
|---|---|---|
| `delegated` | PM bot (`PutItem`) | Task created, not yet acked |
| `accepted` | Worker (`UpdateItem`) | Worker acknowledged, work in progress |
| `shipped` | Worker (`UpdateItem`) | Worker's work is complete |
| `signed_off` | Human/sign-off skill | Human approved shipped work |
| `merged` | PM or worker | Artifact (PR) merged |
| `blocked` | Worker (`UpdateItem`) | Worker needs something to continue |
| `abandoned` | PM bot (`UpdateItem`) | Task cancelled |

### Global Secondary Indexes

**GSI1 — `ProjectStatusIndex`**
- Hash key: `GSI1PK` = `PROJECT#<slug>#STATUS#<status>`
- Range key: `delegated_at`
- Use: PM heartbeat — "all pending tasks for project X, oldest first"

**GSI2 — `StatusIndex`**
- Hash key: `GSI2PK` = `STATUS#<status>`
- Range key: `delegated_at`
- Use: cross-project queries — "all tasks in `delegated`/`accepted`/`shipped` state"
- ⚠️ Hot-partition note: `STATUS#merged` accumulates all merged tasks system-wide.
  At >10k items, consider sharding: `STATUS#merged#<bucket>`.

### Conditional-write rules

| Operation | Actor | Condition |
|---|---|---|
| Initial `PutItem` (delegated) | PM bot only | `attribute_not_exists(PK)` |
| `accepted` | Worker only | `status = delegated AND worker = :worker` |
| `shipped` | Worker only | `status = accepted AND worker = :worker` |
| `signed_off` | Sign-off role | `status = shipped AND lifecycle = requires-human-signoff` |
| `merged` | PM or worker | `status IN (shipped, signed_off)` |
| `blocked` | Worker only | `status IN (delegated, accepted) AND worker = :worker` |
| `abandoned` | PM bot only | `status NOT IN (merged, abandoned)` |

IAM does the coarse separation (PM can `PutItem`; worker cannot). `ConditionExpression`
does the fine-grained per-row protection (worker can only update their own tasks).

## S3 schema

**Bucket:** `{name_prefix}ledger` (default: `fleetmind-ledger`)

```
s3://{bucket}/
  v0/
    projects/
      <project-slug>/
        README.md                           # PM bot writes once at project bootstrap
        tasks/
          <YYYY-MM-DD>-<task-id>.md         # Worker writes at completion/block
```

Date in the key is the **delegation date** (from `delegated_at`) — never changes.

### Task `.md` schema (`v: 0.2`)

```markdown
---
v: 0.2
task_id: a1b2c3d4
---

## Task
<what was delegated>

## What I did
<outcomes, not a tool-call transcript>

## What I didn't do
<scope cuts, follow-ups, gotchas>

## Links
- PR: <url>
- Preview: <url>

## Learned
<2-5 non-obvious bullets, or []>
```

Status, timestamps, and IDs live in DynamoDB. The `.md` is content only.
Joining: `task_id` in frontmatter ↔ `PK = TASK#<task_id>` in DDB.

### Blocker `.md` schema

Same structure, with `## What I tried` and `## Need` instead of `## What I did`
and `## What I didn't do`.

### `Learned` section: good vs. bad

```
✅ Good:
- Package X's feature Y doesn't work in mode Z — use W instead. Wasted 30 min.
- The IAM role doesn't have permission P by default — had to add it.

❌ Bad (rejected):
- I read the codebase and made changes
- Wrote some code, ran the tests, fixed bugs
- <Technology> is a <category>
```

If you can't write 2-5 non-obvious bullets, use `[]`.

## Wake signaling

Worker `UpdateItem` on terminal status → DDB Stream record (MODIFY, terminal
status) → EventBridge Pipe filter → event bus → EventBridge rule → SSM Run
Command → `ddb-wake.sh` on PM bot's EC2.

EventBridge Pipe filter:
```json
{
  "eventName": ["MODIFY"],
  "dynamodb": {
    "NewImage": {
      "status": {"S": ["shipped", "blocked", "abandoned", "merged"]}
    }
  }
}
```

The Pipe emits `FleetMindTaskTerminalEvent` with `detail = {"pk": "TASK#<task_id>"}`.
The wake script strips the `TASK#` prefix and validates 8-char hex before invoking
the agent. Using `PK` (not the standalone `task_id` attribute) means future
schema changes can't silently break wake delivery.

## IAM model

Three IAM policies (created by the `task-ledger` Terraform module):

| Policy | Who | DDB | S3 |
|---|---|---|---|
| `{prefix}bot-ledger-pm` | PM bots | PutItem + UpdateItem + GetItem + Query | Write README.md, read all |
| `{prefix}bot-ledger-worker` | Worker bots | UpdateItem + GetItem + Query | Write `tasks/*.md`, read all |
| `{prefix}bot-ledger-reader` | Read-only | GetItem + Query | GetObject, ListBucket |

Action-level IAM provides coarse separation (PM can `PutItem`; worker cannot).
`ConditionExpression` provides fine-grained per-row protection (worker checks
`worker = :worker` on every UpdateItem).

## Access patterns

| Who | Action | Implementation |
|---|---|---|
| PM bot | Create task | `fleetmind task create` → `PutItem` with `attribute_not_exists(PK)` |
| PM bot | Heartbeat: pending tasks for project | `fleetmind query pending --project <slug>` → GSI1 query |
| PM bot | Planning: prior tasks for context | `fleetmind query merged --project <slug>` + `fleetmind narrative get` |
| Worker | Resolve task at receive time | `fleetmind task get --task-id <hex>` → single `GetItem` |
| Worker | Ack delegation | `fleetmind task ack --task-id <hex> --worker <id>` |
| Worker | Ship task | `fleetmind narrative put` → `fleetmind task ship` |
| Worker | Block task | `fleetmind narrative put --event blocked` → `fleetmind task block` |
| Human/skill | Sign off | `fleetmind task signoff --task-id <hex>` |
| PM bot | Mark merged | `fleetmind task merge --task-id <hex>` |

**No `aws s3 ls --recursive | grep` patterns.** Workers resolve task metadata
via a single `GetItem`. The `task_s3_key` stored in DDB at creation time is
the canonical S3 path — no listing required.

## Non-features (v0)

- **Not searchable.** No embeddings, no full-text. PM bot queries GSIs + reads S3 narratives.
- **Not summarized.** `Learned` sections are written by the worker who did the work.
- **Not a project manager.** External trackers own "what's the work + what's the status."
- **No event log.** Inter-bot signals stay in Slack threads + DDB status transitions.

## Open questions

1. **Project bootstrap.** v0 punt: consumers seed `v0/projects/<slug>/README.md` manually.
2. **`Learned` quality.** Trust the worker with examples as the bar.
3. **Sign-off IAM.** v0 uses the PM bot role for `signed_off` writes. A future
   `bot-ledger-signoff` role scoped to `shipped → signed_off` only is cleaner.
4. **GSI hot partition.** `STATUS#merged` will grow unbounded. Shard if needed.

## Changelog

- **v0.4:** Disambiguate `accepted`. Previously overloaded for both "worker ack"
  and "human sign-off". Renamed the human sign-off phase to `signed_off`. Status
  enum: `delegated | accepted | shipped | signed_off | merged | blocked | abandoned`.
- **v0.3:** Hybrid DDB+S3 substrate. DDB owns structured state; S3 owns narrative
  content. Wake signal moves from S3 EventBridge → DDB Streams → EventBridge Pipe.
  `delegations/` S3 prefix eliminated.
- **v0.2:** Initial dual-substrate design.
- **v0.1:** Pure S3 design.
