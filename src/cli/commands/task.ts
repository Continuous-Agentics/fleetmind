/**
 * fleetmind task — task ledger lifecycle subcommands
 *
 * Usage:
 *   fleetmind task create --project <slug> --worker <id> --delegated-by <id> --dod <text> ...
 *   fleetmind task ack     --task-id <hex> --worker <id>
 *   fleetmind task ship    --task-id <hex> --worker <id>
 *   fleetmind task block   --task-id <hex> --worker <id>
 *   fleetmind task signoff --task-id <hex>
 *   fleetmind task abandon --task-id <hex>
 *   fleetmind task merge   --task-id <hex>
 *   fleetmind task get     --task-id <hex>
 *   fleetmind task set-nag --task-id <hex>
 *   fleetmind task update  --task-id <hex> [field flags...]
 *
 * Reads the delegation config from fleet.yaml (or --fleet).
 * Output: human-friendly text by default; --json for JSON.
 */

import { Command, Option } from "commander";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { resolveAndLoadFleet } from "../../config/loader.js";
import { TaskLedger, TaskConditionError } from "../../runtime/delegation/ddb.js";
import type { TaskRecord } from "../../runtime/delegation/types.js";
import type { DelegationFleetConfig } from "../../config/schema.js";
import { publishTaskEvent, type TaskEvent } from "../../transport/nats.js";
import { log } from "../../utils/log.js";

// ── NATS helper ────────────────────────────────────────────────────────────

/**
 * Publish a task event to NATS if the fleet config includes NATS transport.
 * Never throws — NATS failures are logged but do not fail the CLI command.
 */
async function maybePublishNats(
  delegation: DelegationFleetConfig | undefined,
  event: TaskEvent
): Promise<void> {
  if (!delegation?.nats) return;
  const transport = delegation.delegation_transport ?? "slack";
  if (transport === "slack") return;
  try {
    await publishTaskEvent(delegation.nats, event);
  } catch (err) {
    log.warn(`[nats] publish failed for ${event.event}/${event.task_id}: ${err}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve the caller identity for `updated_by`.
 * Priority: /etc/fleetmind/agent.env AGENT_ID → process.env.USER → "unknown"
 */
function resolveUpdatedBy(): string {
  try {
    const env = readFileSync("/etc/fleetmind/agent.env", "utf8");
    const match = /^AGENT_ID=(.+)$/m.exec(env);
    if (match?.[1]) return match[1].trim();
  } catch {
    // not on a bot host
  }
  return process.env["USER"] ?? "unknown";
}

// ── Dependency injection interface ────────────────────────────────────────────

/**
 * Minimal interface for task ledger operations — allows injection in tests.
 * The real implementation is TaskLedger from runtime/delegation/ddb.ts.
 */
export interface TaskLedgerLike {
  createTask(input: {
    task_id: string;
    project: string;
    worker: string;
    delegated_by: string;
    definition_of_done: string;
    delegation_thread: string;
    delegation_envelope_ts: string;
    tracker_link?: string;
    lifecycle?: "requires-human-signoff" | "shipped-is-done";
    s3_key_template?: string;
  }): Promise<TaskRecord>;
  getTask(taskId: string): Promise<TaskRecord | undefined>;
  ackTask(taskId: string, worker: string, project?: string): Promise<void>;
  shipTask(taskId: string, worker: string, project?: string): Promise<void>;
  blockTask(taskId: string, worker: string, project?: string): Promise<void>;
  unblockTask(taskId: string, worker: string, reason?: string, project?: string): Promise<void>;
  signoffTask(taskId: string, project?: string): Promise<void>;
  abandonTask(taskId: string, project?: string): Promise<void>;
  mergeTask(taskId: string, project?: string): Promise<void>;
  setNag(taskId: string): Promise<void>;
  updateTaskMetadata(
    taskId: string,
    updates: {
      title?: string;
      description?: string;
      definition_of_done?: string;
      worker_id?: string;
      thread_url?: string;
      envelope_ts?: string;
      project?: string;
    },
    options?: {
      by?: string;
      reason?: string;
    }
  ): Promise<TaskRecord>;
}

// ── Subcommand option shapes ──────────────────────────────────────────────────

export interface CreateTaskOptions {
  project: string;
  worker: string;
  delegatedBy: string;
  dod: string;
  thread: string;
  envelopeTs: string;
  tracker?: string;
  lifecycle?: "requires-human-signoff" | "shipped-is-done";
  taskId?: string;
  fleet?: string;
  json?: boolean;
}

export interface WorkerTaskOptions {
  taskId: string;
  worker: string;
  project?: string;
  fleet?: string;
  json?: boolean;
}

export interface UnblockTaskOptions {
  taskId: string;
  worker: string;
  reason?: string;
  project?: string;
  fleet?: string;
  region?: string;
  json?: boolean;
}

export interface ProjectTaskOptions {
  taskId: string;
  project?: string;
  fleet?: string;
  json?: boolean;
}

export interface GetTaskOptions {
  taskId: string;
  fleet?: string;
  json?: boolean;
}

export interface SetNagOptions {
  taskId: string;
  fleet?: string;
  json?: boolean;
}

export interface UpdateTaskOptions {
  taskId: string;
  title?: string;
  description?: string;
  descriptionFile?: string;
  dod?: string;
  worker?: string;
  thread?: string;
  envelopeTs?: string;
  project?: string;
  by?: string;
  reason?: string;
  fleet?: string;
  region?: string;
  json?: boolean;
}

// ── Result shapes ─────────────────────────────────────────────────────────────

export interface TaskCommandResult {
  task_id: string;
  status?: string;
  message?: string;
}

// ── Ledger helper ─────────────────────────────────────────────────────────────

function makeLedger(fleet: ReturnType<typeof resolveAndLoadFleet>): TaskLedger {
  const d = fleet.delegation;
  if (!d?.enabled || !d.table_name) {
    log.error(
      "Delegation is not enabled in this fleet. Set delegation.enabled = true and delegation.table_name in fleet.yaml."
    );
    process.exit(1);
  }
  return new TaskLedger({
    tableName: d.table_name,
    region: d.aws_region,
  });
}

function output(data: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof data === "string") {
    console.log(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

function generateTaskId(): string {
  return randomBytes(4).toString("hex");
}

function handleError(err: unknown): never {
  if (err instanceof TaskConditionError) {
    log.error(err.message);
    process.exit(2);
  }
  throw err;
}

// ── Pure subcommand logic (testable via DI) ───────────────────────────────────

/** Create a new task record; returns the created TaskRecord. */
export async function createTask(
  opts: CreateTaskOptions,
  ledger: TaskLedgerLike
): Promise<TaskRecord> {
  const taskId = opts.taskId ?? generateTaskId();
  try {
    return await ledger.createTask({
      task_id: taskId,
      project: opts.project,
      worker: opts.worker,
      delegated_by: opts.delegatedBy,
      definition_of_done: opts.dod,
      delegation_thread: opts.thread,
      delegation_envelope_ts: opts.envelopeTs,
      tracker_link: opts.tracker,
      lifecycle: opts.lifecycle,
    });
  } catch (err) {
    if (err instanceof TaskConditionError) {
      throw new TaskConditionError(
        `Task ID ${taskId} already exists — regenerate the ID.`
      );
    }
    throw err;
  }
}

/** Get a task record by ID. Returns undefined if not found. */
export async function getTask(
  opts: GetTaskOptions,
  ledger: TaskLedgerLike
): Promise<TaskRecord | undefined> {
  return ledger.getTask(opts.taskId);
}

/** Acknowledge a delegation (delegated → accepted). */
export async function ackTask(
  opts: WorkerTaskOptions,
  ledger: TaskLedgerLike
): Promise<void> {
  return ledger.ackTask(opts.taskId, opts.worker, opts.project);
}

/** Mark a task shipped (accepted → shipped). */
export async function shipTask(
  opts: WorkerTaskOptions,
  ledger: TaskLedgerLike
): Promise<void> {
  return ledger.shipTask(opts.taskId, opts.worker, opts.project);
}

/** Mark a task blocked (delegated|accepted → blocked). */
export async function blockTask(
  opts: WorkerTaskOptions,
  ledger: TaskLedgerLike
): Promise<void> {
  return ledger.blockTask(opts.taskId, opts.worker, opts.project);
}

/** Unblock a task (blocked → accepted). */
export async function unblockTask(
  opts: UnblockTaskOptions,
  ledger: TaskLedgerLike
): Promise<void> {
  return ledger.unblockTask(opts.taskId, opts.worker, opts.reason, opts.project);
}

/** Sign off on a shipped task (shipped → signed_off). */
export async function signoffTask(
  opts: ProjectTaskOptions,
  ledger: TaskLedgerLike
): Promise<void> {
  return ledger.signoffTask(opts.taskId, opts.project);
}

/** Abandon a task (any non-terminal → abandoned). */
export async function abandonTask(
  opts: ProjectTaskOptions,
  ledger: TaskLedgerLike
): Promise<void> {
  return ledger.abandonTask(opts.taskId, opts.project);
}

/** Mark a task merged (shipped|signed_off → merged). */
export async function mergeTask(
  opts: ProjectTaskOptions,
  ledger: TaskLedgerLike
): Promise<void> {
  return ledger.mergeTask(opts.taskId, opts.project);
}

/** Set last_nag_at to now (idempotent). */
export async function setNagTask(
  opts: SetNagOptions,
  ledger: TaskLedgerLike
): Promise<void> {
  return ledger.setNag(opts.taskId);
}

/**
 * Update mutable task metadata fields.
 *
 * Reads description from stdin if `--description -` is passed.
 * Reads description from file if `--description-file <path>` is passed.
 * At least one field flag must be present.
 */
export async function updateTask(
  opts: UpdateTaskOptions,
  ledger: TaskLedgerLike
): Promise<TaskRecord> {
  // Resolve description from file or stdin
  let description: string | undefined = opts.description;
  if (opts.descriptionFile) {
    if (opts.descriptionFile === "-") {
      // Read from stdin
      description = readFileSync("/dev/stdin", "utf8").trim();
    } else {
      description = readFileSync(opts.descriptionFile, "utf8").trim();
    }
  }

  // Build the updates map — only include keys that were passed
  const updates: Parameters<TaskLedgerLike["updateTaskMetadata"]>[1] = {};
  if (opts.title !== undefined) updates.title = opts.title;
  if (description !== undefined) updates.description = description;
  if (opts.dod !== undefined) updates.definition_of_done = opts.dod;
  if (opts.worker !== undefined) updates.worker_id = opts.worker;
  if (opts.thread !== undefined) updates.thread_url = opts.thread;
  if (opts.envelopeTs !== undefined) updates.envelope_ts = opts.envelopeTs;
  if (opts.project !== undefined) updates.project = opts.project;

  if (Object.keys(updates).length === 0) {
    log.error("no fields to update — pass at least one field flag (--title, --description, --dod, --worker, --thread, --envelope-ts, --project)");
    process.exit(1);
  }

  const by = opts.by ?? resolveUpdatedBy();

  return ledger.updateTaskMetadata(opts.taskId, updates, { by, reason: opts.reason });
}

// ── Register ──────────────────────────────────────────────────────────────────

export function registerTask(program: Command): void {
  const task = program
    .command("task")
    .description("Manage task ledger lifecycle (create, ack, ship, block, unblock, signoff, abandon, merge, get, update, set-nag)")
    .addHelpText('after', `
Subcommands:
  create    Create a new task record (PM bot: initial delegation)
  get       Get a task record by ID
  ack       Acknowledge a delegation (delegated → accepted)
  ship      Mark a task shipped (accepted → shipped)
  block     Mark a task blocked
  unblock   Unblock a task (blocked → accepted)
  signoff   Sign off on a shipped task
  abandon   Abandon a task
  merge     Mark a task merged
  set-nag   Set last_nag_at to now
  update    Update mutable task metadata in flight

Run \`fleetmind task <subcommand> --help\` for examples.
`);

  // ── create ──────────────────────────────────────────────────────────────

  task
    .command("create")
    .description("Create a new task record (PM bot: initial delegation)")
    .requiredOption("--project <slug>", "Project slug (e.g. website-rewrite)")
    .requiredOption("--worker <id>", "Worker bot identifier (Slack user ID or agent ID)")
    .requiredOption("--delegated-by <id>", "PM bot identifier")
    .requiredOption("--dod <text>", "Definition of done")
    .requiredOption("--thread <url>", "Delegation thread URL / Slack permalink")
    .requiredOption("--envelope-ts <ts>", "Envelope message timestamp / ID")
    .option("--tracker <url>", "External tracker link (Linear, Jira, etc.)")
    .addOption(
      new Option("--lifecycle <mode>", "Lifecycle policy")
        .choices(["requires-human-signoff", "shipped-is-done"])
        .default("requires-human-signoff"),
    )
    .option("--task-id <hex>", "Override generated task ID (8-char hex)")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--json", "Output JSON")
    .addHelpText('after', `
Examples:
  # Create a task in the website-rewrite project
  $ fleetmind task create \\
      --project website-rewrite --worker forge --delegated-by pm-bot \\
      --dod "PR merged and CI green" \\
      --thread https://acme.slack.com/archives/C0123456789/p1234567890 \\
      --envelope-ts 1234567890.123456

  # Create a task with a Linear tracker link
  $ fleetmind task create \\
      --project api-refactor --worker forge --delegated-by pm-bot \\
      --dod "All endpoints migrated" \\
      --thread https://acme.slack.com/archives/C0123456789/p1234567890 \\
      --envelope-ts 1234567890.123456 \\
      --tracker https://linear.app/acme/issue/ENG-42
`)
    .action(async (opts: CreateTaskOptions) => {
      const fleet = resolveAndLoadFleet(opts.fleet);
      const ledger = makeLedger(fleet);
      try {
        const record = await createTask(opts, ledger);
        output(
          opts.json
            ? record
            : `Created task ${record.task_id} for project ${record.project} (status: delegated)`,
          opts.json ?? false
        );
        // Publish delegation event to NATS if transport is nats or both.
        await maybePublishNats(fleet.delegation, {
          v: "1.0",
          event: "delegation",
          task_id: record.task_id,
          project: record.project,
          worker: record.worker,
          delegated_by: record.delegated_by,
          at: record.delegated_at,
          definition_of_done: record.definition_of_done,
          tracker_link: record.tracker_link ?? undefined,
          delegation_thread: record.delegation_thread,
          delegation_envelope_ts: record.delegation_envelope_ts,
        });
      } catch (err) {
        if (err instanceof TaskConditionError) {
          log.error(err.message);
          process.exit(2);
        }
        throw err;
      }
    });

  // ── ack ──────────────────────────────────────────────────────────────────

  task
    .command("ack")
    .description("Acknowledge a delegation (worker: delegated→accepted)")
    .requiredOption("--task-id <hex>", "Task ID (8-char hex)")
    .requiredOption("--worker <id>", "Worker bot identifier")
    .option("--project <slug>", "Project slug (avoids a GetItem round-trip; skill knows from prior 'task get')")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--json", "Output JSON")
    .addHelpText('after', `
Examples:
  # Acknowledge a task delegation (worker accepts the work)
  $ fleetmind task ack --task-id a1b2c3d4 --worker forge

  # Acknowledge with project slug to skip a DynamoDB round-trip
  $ fleetmind task ack --task-id a1b2c3d4 --worker forge --project website-rewrite
`)
    .action(async (opts: WorkerTaskOptions) => {
      const fleet = resolveAndLoadFleet(opts.fleet);
      const ledger = makeLedger(fleet);
      try {
        await ackTask(opts, ledger);
        output(
          opts.json
            ? { task_id: opts.taskId, status: "accepted" }
            : `Task ${opts.taskId} acknowledged (status: accepted)`,
          opts.json ?? false
        );
        // Publish ack event to NATS if transport includes it.
        const record = await ledger.getTask(opts.taskId);
        if (record) {
          await maybePublishNats(fleet.delegation, {
            v: "1.0",
            event: "ack",
            task_id: record.task_id,
            project: record.project,
            worker: record.worker,
            delegated_by: record.delegated_by,
            at: record.accepted_at ?? new Date().toISOString(),
          });
        }
      } catch (err) { handleError(err); }
    });

  // ── ship ─────────────────────────────────────────────────────────────────

  task
    .command("ship")
    .description("Mark a task shipped (worker: accepted→shipped)")
    .requiredOption("--task-id <hex>", "Task ID")
    .requiredOption("--worker <id>", "Worker bot identifier")
    .option("--project <slug>", "Project slug (avoids a GetItem round-trip)")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--json", "Output JSON")
    .addHelpText('after', `
Examples:
  # Mark a task shipped when the PR is up
  $ fleetmind task ship --task-id a1b2c3d4 --worker forge

  # Ship with project slug to skip a DynamoDB round-trip
  $ fleetmind task ship --task-id a1b2c3d4 --worker forge --project website-rewrite
`)
    .action(async (opts: WorkerTaskOptions) => {
      const fleet = resolveAndLoadFleet(opts.fleet);
      const ledger = makeLedger(fleet);
      try {
        await shipTask(opts, ledger);
        output(
          opts.json
            ? { task_id: opts.taskId, status: "shipped" }
            : `Task ${opts.taskId} shipped (status: shipped)`,
          opts.json ?? false
        );
        // Publish ship event to NATS if transport includes it.
        const record = await ledger.getTask(opts.taskId);
        if (record) {
          await maybePublishNats(fleet.delegation, {
            v: "1.0",
            event: "ship",
            task_id: record.task_id,
            project: record.project,
            worker: record.worker,
            delegated_by: record.delegated_by,
            at: record.shipped_at ?? new Date().toISOString(),
          });
        }
      } catch (err) { handleError(err); }
    });

  // ── block ────────────────────────────────────────────────────────────────

  task
    .command("block")
    .description("Mark a task blocked (worker: delegated|accepted→blocked)")
    .requiredOption("--task-id <hex>", "Task ID")
    .requiredOption("--worker <id>", "Worker bot identifier")
    .option("--project <slug>", "Project slug (avoids a GetItem round-trip)")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--json", "Output JSON")
    .addHelpText('after', `
Examples:
  # Mark a task blocked (waiting on an external dependency)
  $ fleetmind task block --task-id a1b2c3d4 --worker forge

  # Block with project slug to skip a DynamoDB round-trip
  $ fleetmind task block --task-id a1b2c3d4 --worker forge --project api-refactor
`)
    .action(async (opts: WorkerTaskOptions) => {
      const fleet = resolveAndLoadFleet(opts.fleet);
      const ledger = makeLedger(fleet);
      try {
        await blockTask(opts, ledger);
        output(
          opts.json
            ? { task_id: opts.taskId, status: "blocked" }
            : `Task ${opts.taskId} blocked (status: blocked)`,
          opts.json ?? false
        );
        // Publish block event to NATS if transport includes it.
        const record = await ledger.getTask(opts.taskId);
        if (record) {
          await maybePublishNats(fleet.delegation, {
            v: "1.0",
            event: "block",
            task_id: record.task_id,
            project: record.project,
            worker: record.worker,
            delegated_by: record.delegated_by,
            at: record.blocked_at ?? new Date().toISOString(),
          });
        }
      } catch (err) { handleError(err); }
    });

  // ── unblock ──────────────────────────────────────────────────────────────

  task
    .command("unblock")
    .description("Unblock a task (worker: blocked→accepted), ready to ship again")
    .requiredOption("--task-id <hex>", "Task ID (8-char hex)")
    .requiredOption("--worker <id>", "Worker bot identifier")
    .option("--reason <text>", "Why the block was resolved (stored in unblocked_reason)")
    .option("--project <slug>", "Project slug (avoids a GetItem round-trip)")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--region <region>", "AWS region (default us-west-2)")
    .option("--json", "Output JSON")
    .addHelpText('after', `
Examples:
  # Unblock a task when the blocker is resolved
  $ fleetmind task unblock --task-id a1b2c3d4 --worker forge

  # Unblock with a reason explaining what resolved the block
  $ fleetmind task unblock --task-id a1b2c3d4 --worker forge \\
      --reason "External API credentials are now available"
`)
    .action(async (opts: UnblockTaskOptions) => {
      const ledger = makeLedger(resolveAndLoadFleet(opts.fleet));
      try {
        await unblockTask(opts, ledger);
        output(
          opts.json
            ? { task_id: opts.taskId, status: "accepted" }
            : `Task ${opts.taskId} unblocked (status: accepted)`,
          opts.json ?? false
        );
      } catch (err) { handleError(err); }
    });

  // ── signoff ──────────────────────────────────────────────────────────────

  task
    .command("signoff")
    .description("Sign off on a shipped task (shipped→signed_off, requires lifecycle=requires-human-signoff)")
    .requiredOption("--task-id <hex>", "Task ID")
    .option("--project <slug>", "Project slug (avoids a GetItem round-trip)")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--json", "Output JSON")
    .addHelpText('after', `
Examples:
  # Sign off on a shipped task (human approval step)
  $ fleetmind task signoff --task-id a1b2c3d4

  # Sign off with project slug to skip a DynamoDB round-trip
  $ fleetmind task signoff --task-id a1b2c3d4 --project website-rewrite
`)
    .action(async (opts: ProjectTaskOptions) => {
      const ledger = makeLedger(resolveAndLoadFleet(opts.fleet));
      try {
        await signoffTask(opts, ledger);
        output(
          opts.json
            ? { task_id: opts.taskId, status: "signed_off" }
            : `Task ${opts.taskId} signed off (status: signed_off)`,
          opts.json ?? false
        );
      } catch (err) { handleError(err); }
    });

  // ── abandon ──────────────────────────────────────────────────────────────

  task
    .command("abandon")
    .description("Abandon a task (PM bot only: any status→abandoned, except merged/abandoned)")
    .requiredOption("--task-id <hex>", "Task ID")
    .option("--project <slug>", "Project slug (avoids a GetItem round-trip)")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--json", "Output JSON")
    .addHelpText('after', `
Examples:
  # Abandon a task that is no longer needed
  $ fleetmind task abandon --task-id a1b2c3d4

  # Abandon with project slug to skip a DynamoDB round-trip
  $ fleetmind task abandon --task-id a1b2c3d4 --project website-rewrite
`)
    .action(async (opts: ProjectTaskOptions) => {
      const ledger = makeLedger(resolveAndLoadFleet(opts.fleet));
      try {
        await abandonTask(opts, ledger);
        output(
          opts.json
            ? { task_id: opts.taskId, status: "abandoned" }
            : `Task ${opts.taskId} abandoned (status: abandoned)`,
          opts.json ?? false
        );
      } catch (err) { handleError(err); }
    });

  // ── merge ────────────────────────────────────────────────────────────────

  task
    .command("merge")
    .description("Mark a task merged (shipped|signed_off→merged)")
    .requiredOption("--task-id <hex>", "Task ID")
    .option("--project <slug>", "Project slug (avoids a GetItem round-trip)")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--json", "Output JSON")
    .addHelpText('after', `
Examples:
  # Mark a task merged after the PR lands
  $ fleetmind task merge --task-id a1b2c3d4

  # Merge with project slug to skip a DynamoDB round-trip
  $ fleetmind task merge --task-id a1b2c3d4 --project website-rewrite
`)
    .action(async (opts: ProjectTaskOptions) => {
      const ledger = makeLedger(resolveAndLoadFleet(opts.fleet));
      try {
        await mergeTask(opts, ledger);
        output(
          opts.json
            ? { task_id: opts.taskId, status: "merged" }
            : `Task ${opts.taskId} merged (status: merged)`,
          opts.json ?? false
        );
      } catch (err) { handleError(err); }
    });

  // ── get ──────────────────────────────────────────────────────────────────

  task
    .command("get")
    .description("Get a task record by task ID")
    .requiredOption("--task-id <hex>", "Task ID")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--json", "Output JSON (default: human-readable)")
    .addHelpText('after', `
Examples:
  # Get a human-readable summary of a task
  $ fleetmind task get --task-id a1b2c3d4

  # Get full task record as JSON (useful for scripting)
  $ fleetmind task get --task-id a1b2c3d4 --json
`)
    .action(async (opts: GetTaskOptions) => {
      const ledger = makeLedger(resolveAndLoadFleet(opts.fleet));
      const record = await getTask(opts, ledger);
      if (!record) {
        log.warn(`Task not found: ${opts.taskId}`);
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify(record, null, 2));
      } else {
        // Compact human-readable summary; full JSON via --json.
        console.log(
          `Task ${record.task_id} [${record.status}]\n` +
            `  project:        ${record.project}\n` +
            `  worker:         ${record.worker}\n` +
            `  delegated_by:   ${record.delegated_by}\n` +
            `  delegated_at:   ${record.delegated_at}\n` +
            (record.accepted_at ? `  accepted_at:    ${record.accepted_at}\n` : "") +
            (record.shipped_at ? `  shipped_at:     ${record.shipped_at}\n` : "") +
            (record.signed_off_at ? `  signed_off_at:  ${record.signed_off_at}\n` : "") +
            (record.merged_at ? `  merged_at:      ${record.merged_at}\n` : "") +
            (record.blocked_at ? `  blocked_at:     ${record.blocked_at}\n` : "") +
            (record.abandoned_at ? `  abandoned_at:   ${record.abandoned_at}\n` : "") +
            (record.last_nag_at ? `  last_nag_at:    ${record.last_nag_at}\n` : "") +
            `  lifecycle:      ${record.lifecycle}\n` +
            `  s3_key:         ${record.task_s3_key}\n` +
            `  thread:         ${record.delegation_thread}\n` +
            (record.tracker_link ? `  tracker:        ${record.tracker_link}\n` : "") +
            `\n(use --json for full record)`,
        );
      }
    });

  // ── update ────────────────────────────────────────────────────────────

  task
    .command("update")
    .description("Update mutable task metadata in flight (title, description, DoD, worker, thread, project)")
    .requiredOption("--task-id <hex>", "Task ID (8-char hex)")
    .option("--title <text>", "Update task title")
    .option("--description <text>", "Update description (use - to read from stdin)")
    .option("--description-file <path>", "Read description from file (use - for stdin)")
    .option("--dod <text>", "Update definition of done")
    .option("--worker <id>", "Reassign to a different worker bot")
    .option("--thread <url>", "Update delegation thread URL (Slack permalink)")
    .option("--envelope-ts <ts>", "Update envelope message timestamp")
    .option("--project <slug>", "Move to a different project (also updates GSI1PK)")
    .option("--by <id>", "Override the updated_by identity (default: agent env discovery)")
    .option("--reason <text>", "Reason for update (appended to update_history)")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--region <region>", "AWS region (default us-west-2)")
    .option("--json", "Output JSON")
    .addHelpText('after', `
Examples:
  # Update the definition of done for a task
  $ fleetmind task update --task-id a1b2c3d4 --dod "All tests pass and docs updated"

  # Reassign a task to a different worker
  $ fleetmind task update --task-id a1b2c3d4 --worker worker-bot

  # Move a task to a different project
  $ fleetmind task update --task-id a1b2c3d4 --project new-project-slug

  # Update description from a file (useful for long text)
  $ fleetmind task update --task-id a1b2c3d4 --description-file ./context.md

  # Update with an audit reason logged to update_history
  $ fleetmind task update --task-id a1b2c3d4 --dod "Revised scope" --reason "PM adjusted requirements"
`)
    .action(async (opts: UpdateTaskOptions) => {
      const ledger = makeLedger(resolveAndLoadFleet(opts.fleet));
      try {
        const record = await updateTask(opts, ledger);
        output(
          opts.json
            ? record
            : `Task ${record.task_id} updated (project: ${record.project}, status: ${record.status})`,
          opts.json ?? false
        );
      } catch (err) { handleError(err); }
    });

  // ── set-nag ──────────────────────────────────────────────────────────────

  task
    .command("set-nag")
    .description("Set last_nag_at to now (idempotent; used by PM heartbeat)")
    .requiredOption("--task-id <hex>", "Task ID")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--json", "Output JSON")
    .addHelpText('after', `
Examples:
  # Record that a nag was sent for a task (updates last_nag_at)
  $ fleetmind task set-nag --task-id a1b2c3d4

  # Same, with JSON output for scripting
  $ fleetmind task set-nag --task-id a1b2c3d4 --json
`)
    .action(async (opts: SetNagOptions) => {
      const ledger = makeLedger(resolveAndLoadFleet(opts.fleet));
      try {
        await setNagTask(opts, ledger);
        output(
          opts.json
            ? { task_id: opts.taskId, last_nag_at: new Date().toISOString() }
            : `Task ${opts.taskId} nag timestamp updated`,
          opts.json ?? false
        );
      } catch (err) { handleError(err); }
    });
}
