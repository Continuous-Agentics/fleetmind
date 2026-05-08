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
 *
 * Reads the delegation config from fleet.yaml (or --fleet).
 * Output: human-friendly text by default; --json for JSON.
 */

import { Command } from "commander";
import { randomBytes } from "crypto";
import { loadFleet } from "../../config/loader.js";
import { TaskLedger, TaskConditionError } from "../../runtime/delegation/ddb.js";
import { log } from "../../utils/log.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLedger(fleet: ReturnType<typeof loadFleet>): TaskLedger {
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

// ── Register ──────────────────────────────────────────────────────────────────

export function registerTask(program: Command): void {
  const task = program
    .command("task")
    .description("Manage task ledger lifecycle (delegation, ack, ship, block, signoff, abandon, merge, get)");

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
    .option("--lifecycle <mode>", "requires-human-signoff | shipped-is-done", "requires-human-signoff")
    .option("--task-id <hex>", "Override generated task ID (8-char hex)")
    .option("--fleet <file>", "fleet.yaml path", "fleet.yaml")
    .option("--json", "Output JSON")
    .action(async (opts: {
      project: string;
      worker: string;
      delegatedBy: string;
      dod: string;
      thread: string;
      envelopeTs: string;
      tracker?: string;
      lifecycle?: string;
      taskId?: string;
      fleet: string;
      json?: boolean;
    }) => {
      const fleet = loadFleet(opts.fleet);
      const ledger = makeLedger(fleet);
      const taskId = opts.taskId ?? generateTaskId();

      try {
        const record = await ledger.createTask({
          task_id: taskId,
          project: opts.project,
          worker: opts.worker,
          delegated_by: opts.delegatedBy,
          definition_of_done: opts.dod,
          delegation_thread: opts.thread,
          delegation_envelope_ts: opts.envelopeTs,
          tracker_link: opts.tracker,
          lifecycle: (opts.lifecycle as "requires-human-signoff" | "shipped-is-done") ?? "requires-human-signoff",
          s3_key_template: fleet.delegation?.s3_key_template,
        });
        output(opts.json ? record : `Created task ${record.task_id} for project ${record.project} (status: delegated)`, opts.json ?? false);
      } catch (err) {
        if (err instanceof TaskConditionError) {
          log.error(`Task ID ${taskId} already exists — regenerate the ID.`);
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
    .option("--fleet <file>", "fleet.yaml path", "fleet.yaml")
    .option("--json", "Output JSON")
    .action(async (opts: { taskId: string; worker: string; fleet: string; json?: boolean }) => {
      const ledger = makeLedger(loadFleet(opts.fleet));
      try {
        await ledger.ackTask(opts.taskId, opts.worker);
        output(opts.json ? { task_id: opts.taskId, status: "accepted" } : `Task ${opts.taskId} acknowledged (status: accepted)`, opts.json ?? false);
      } catch (err) { handleError(err); }
    });

  // ── ship ─────────────────────────────────────────────────────────────────

  task
    .command("ship")
    .description("Mark a task shipped (worker: accepted→shipped)")
    .requiredOption("--task-id <hex>", "Task ID")
    .requiredOption("--worker <id>", "Worker bot identifier")
    .option("--fleet <file>", "fleet.yaml path", "fleet.yaml")
    .option("--json", "Output JSON")
    .action(async (opts: { taskId: string; worker: string; fleet: string; json?: boolean }) => {
      const ledger = makeLedger(loadFleet(opts.fleet));
      try {
        await ledger.shipTask(opts.taskId, opts.worker);
        output(opts.json ? { task_id: opts.taskId, status: "shipped" } : `Task ${opts.taskId} shipped (status: shipped)`, opts.json ?? false);
      } catch (err) { handleError(err); }
    });

  // ── block ────────────────────────────────────────────────────────────────

  task
    .command("block")
    .description("Mark a task blocked (worker: delegated|accepted→blocked)")
    .requiredOption("--task-id <hex>", "Task ID")
    .requiredOption("--worker <id>", "Worker bot identifier")
    .option("--fleet <file>", "fleet.yaml path", "fleet.yaml")
    .option("--json", "Output JSON")
    .action(async (opts: { taskId: string; worker: string; fleet: string; json?: boolean }) => {
      const ledger = makeLedger(loadFleet(opts.fleet));
      try {
        await ledger.blockTask(opts.taskId, opts.worker);
        output(opts.json ? { task_id: opts.taskId, status: "blocked" } : `Task ${opts.taskId} blocked (status: blocked)`, opts.json ?? false);
      } catch (err) { handleError(err); }
    });

  // ── signoff ──────────────────────────────────────────────────────────────

  task
    .command("signoff")
    .description("Sign off on a shipped task (shipped→signed_off, requires lifecycle=requires-human-signoff)")
    .requiredOption("--task-id <hex>", "Task ID")
    .option("--fleet <file>", "fleet.yaml path", "fleet.yaml")
    .option("--json", "Output JSON")
    .action(async (opts: { taskId: string; fleet: string; json?: boolean }) => {
      const ledger = makeLedger(loadFleet(opts.fleet));
      try {
        await ledger.signoffTask(opts.taskId);
        output(opts.json ? { task_id: opts.taskId, status: "signed_off" } : `Task ${opts.taskId} signed off (status: signed_off)`, opts.json ?? false);
      } catch (err) { handleError(err); }
    });

  // ── abandon ──────────────────────────────────────────────────────────────

  task
    .command("abandon")
    .description("Abandon a task (PM bot only: any status→abandoned, except merged/abandoned)")
    .requiredOption("--task-id <hex>", "Task ID")
    .option("--fleet <file>", "fleet.yaml path", "fleet.yaml")
    .option("--json", "Output JSON")
    .action(async (opts: { taskId: string; fleet: string; json?: boolean }) => {
      const ledger = makeLedger(loadFleet(opts.fleet));
      try {
        await ledger.abandonTask(opts.taskId);
        output(opts.json ? { task_id: opts.taskId, status: "abandoned" } : `Task ${opts.taskId} abandoned (status: abandoned)`, opts.json ?? false);
      } catch (err) { handleError(err); }
    });

  // ── merge ────────────────────────────────────────────────────────────────

  task
    .command("merge")
    .description("Mark a task merged (shipped|signed_off→merged)")
    .requiredOption("--task-id <hex>", "Task ID")
    .option("--fleet <file>", "fleet.yaml path", "fleet.yaml")
    .option("--json", "Output JSON")
    .action(async (opts: { taskId: string; fleet: string; json?: boolean }) => {
      const ledger = makeLedger(loadFleet(opts.fleet));
      try {
        await ledger.mergeTask(opts.taskId);
        output(opts.json ? { task_id: opts.taskId, status: "merged" } : `Task ${opts.taskId} merged (status: merged)`, opts.json ?? false);
      } catch (err) { handleError(err); }
    });

  // ── get ──────────────────────────────────────────────────────────────────

  task
    .command("get")
    .description("Get a task record by task ID")
    .requiredOption("--task-id <hex>", "Task ID")
    .option("--fleet <file>", "fleet.yaml path", "fleet.yaml")
    .option("--json", "Output JSON (default when task found)")
    .action(async (opts: { taskId: string; fleet: string; json?: boolean }) => {
      const ledger = makeLedger(loadFleet(opts.fleet));
      const record = await ledger.getTask(opts.taskId);
      if (!record) {
        log.warn(`Task not found: ${opts.taskId}`);
        process.exit(1);
      }
      console.log(JSON.stringify(record, null, 2));
    });
}
