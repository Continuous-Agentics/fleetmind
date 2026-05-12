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
 *
 * Reads the delegation config from fleet.yaml (or --fleet).
 * Output: human-friendly text by default; --json for JSON.
 */

import { Command, Option } from "commander";
import { randomBytes } from "crypto";
import { resolveAndLoadFleet } from "../../config/loader.js";
import { TaskLedger, TaskConditionError } from "../../runtime/delegation/ddb.js";
import type { TaskRecord } from "../../runtime/delegation/types.js";
import { log } from "../../utils/log.js";

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
  signoffTask(taskId: string, project?: string): Promise<void>;
  abandonTask(taskId: string, project?: string): Promise<void>;
  mergeTask(taskId: string, project?: string): Promise<void>;
  setNag(taskId: string): Promise<void>;
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

// ── Result shapes ─────────────────────────────────────────────────────────────

export interface TaskCommandResult {
  task_id: string;
  status?: string;
  message?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Register ──────────────────────────────────────────────────────────────────

export function registerTask(program: Command): void {
  const task = program
    .command("task")
    .description("Manage task ledger lifecycle (delegation, ack, ship, block, signoff, abandon, merge, get, set-nag)");

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
    .action(async (opts: CreateTaskOptions) => {
      const ledger = makeLedger(resolveAndLoadFleet(opts.fleet));
      try {
        const record = await createTask(opts, ledger);
        output(
          opts.json
            ? record
            : `Created task ${record.task_id} for project ${record.project} (status: delegated)`,
          opts.json ?? false
        );
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
    .action(async (opts: WorkerTaskOptions) => {
      const ledger = makeLedger(resolveAndLoadFleet(opts.fleet));
      try {
        await ackTask(opts, ledger);
        output(
          opts.json
            ? { task_id: opts.taskId, status: "accepted" }
            : `Task ${opts.taskId} acknowledged (status: accepted)`,
          opts.json ?? false
        );
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
    .action(async (opts: WorkerTaskOptions) => {
      const ledger = makeLedger(resolveAndLoadFleet(opts.fleet));
      try {
        await shipTask(opts, ledger);
        output(
          opts.json
            ? { task_id: opts.taskId, status: "shipped" }
            : `Task ${opts.taskId} shipped (status: shipped)`,
          opts.json ?? false
        );
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
    .action(async (opts: WorkerTaskOptions) => {
      const ledger = makeLedger(resolveAndLoadFleet(opts.fleet));
      try {
        await blockTask(opts, ledger);
        output(
          opts.json
            ? { task_id: opts.taskId, status: "blocked" }
            : `Task ${opts.taskId} blocked (status: blocked)`,
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

  // ── set-nag ──────────────────────────────────────────────────────────────

  task
    .command("set-nag")
    .description("Set last_nag_at to now (idempotent; used by PM heartbeat)")
    .requiredOption("--task-id <hex>", "Task ID")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--json", "Output JSON")
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
