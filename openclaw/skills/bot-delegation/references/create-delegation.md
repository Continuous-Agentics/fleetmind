# Creating an independent fleet delegation — legacy NATS reference

Only for enabled, configured independent fleet routes. Direct work and native children do not use these task-creation steps. NATS publication is a best-effort notification, not durable admission/restart proof. Human-facing delivery uses trusted provider/account/recipient/thread context; the parent owns final closeout.

## 1. Generate a task ID

8-character lowercase hex. Used to correlate the NATS delegation event, DDB record, and S3 narrative.

```bash
TASK_ID=$(python3 -c "import secrets; print(secrets.token_hex(4))")
# Or: openssl rand -hex 4
```

## 2. Write the task record to DynamoDB

Create the task ledger record:

```bash
fleetmind task create \
  --project <project-slug> \
  --worker <worker-agent-id> \
  --delegated-by <pm-bot-id> \
  --dod "<definition of done>" \
  --description "<what needs to be built - context for the worker>" \
  --requestor "<human_slack_uid_if_slack>" \
  --tracker "<tracker_url_if_provided>" \
  --thread "<originating_thread_url_if_available>" \
  --lifecycle requires-human-signoff \
  --task-id "${TASK_ID}" \
  --json
```

`fleetmind task create` attempts to publish the `delegation` event to `fleetmind.delegation.<worker_id>` when NATS is configured. No separate publish step is needed.

If `task create` reports an existing row or an ambiguous network failure, reread the same task ID and verify ownership/state before any retry. Preserve existing history; do not generate a second task to retry ambiguous dispatch. Log an unresolved write as `ledger_write_failed: <reason>` and report the blocker. A known unrelated ID collision may use a new ID only after ruling out prior effects.

**Amending task metadata after delegation:** if scope changes post-delegation (worker pushback, PM clarification, reassignment), use `fleetmind task update` instead of abandoning and recreating - update history is preserved.

```bash
fleetmind task update --task-id <hex> --dod "..." --reason "scope cut after worker review"
```

Also accepts `--worker` (reassign) and `--thread` (fix a wrong URL); always pass `--reason`. Immutable fields (rejected by `task update`): `task_id`, `status`, `created_at`, `created_by`, and all transition timestamps (`accepted_at`, `shipped_at`, etc.). Terminal tasks (`merged`, `abandoned`) are frozen - update will exit 2 with `TaskConditionError`.

**Picking the project slug:**

- A project is a durable initiative, not a single task. "website-rewrite" is a project; "add-date-filter" is a delegation inside it.
- Reuse an existing slug before creating a new one:
  ```bash
  fleetmind query pending --json | jq '[.delegated[].project, .accepted[].project] | unique'
  ```
- Slug format: lowercase, hyphen-separated, ≤30 chars.

**The `task_s3_key` is deterministic** - computed from the project slug, today's UTC date, and task ID. It is stored in DDB at write time. The worker writes to that exact path when done; the PM bot can fetch it later without listing S3.

## 3. Delegation is sent via NATS

`fleetmind task create` (step 2) handles the publish. The worker receives a NATS delegation event containing `task_id`, `description`, `definition_of_done`, `requestor`, and `tracker_link`. No Slack envelope is posted.

Legacy Slack workers may use a configured requestor thread. This is Slack-specific; other providers require supported trusted delivery context. Do not fabricate Slack IDs or routes. The parent owns user-facing closeout.

## 4. Update the audit log

Append a block to `memory/active-delegations.md` under `## Active`. See [../assets/active-delegations-format.md](../assets/active-delegations-format.md) for the full template.

Minimum fields:

- `task_id`, `created` (ISO timestamp), `deadline` (created + 10 min)
- `status: pending`, `project`, `worker`
- `Source planning channel` + `Source planning thread`: where the delegation was discussed
- `ledger_ddb_key`: `TASK#<task_id>`
