/**
 * fleetmind narrative — read/write task narrative content to S3
 *
 * Usage:
 *   fleetmind narrative get --task-id <hex>
 *   fleetmind narrative put --task-id <hex>   (reads stdin)
 *
 * The s3_key is resolved from the DynamoDB task record (single GetItem call).
 * Requires delegation.enabled + delegation.table_name + delegation.s3_bucket.
 */

import { Command } from "commander";
import { loadFleet } from "../../config/loader.js";
import { TaskLedger } from "../../runtime/delegation/ddb.js";
import { NarrativeStore } from "../../runtime/delegation/s3.js";
import { log } from "../../utils/log.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLedger(fleet: ReturnType<typeof loadFleet>): TaskLedger {
  const d = fleet.delegation;
  if (!d?.enabled || !d.table_name) {
    log.error("Delegation is not enabled. Set delegation.enabled = true and delegation.table_name in fleet.yaml.");
    process.exit(1);
  }
  return new TaskLedger({ tableName: d.table_name, region: d.aws_region });
}

function makeNarrativeStore(fleet: ReturnType<typeof loadFleet>): NarrativeStore {
  const d = fleet.delegation;
  if (!d?.enabled || !d.s3_bucket) {
    log.error("Delegation is not enabled. Set delegation.enabled = true and delegation.s3_bucket in fleet.yaml.");
    process.exit(1);
  }
  return new NarrativeStore({ bucket: d.s3_bucket, region: d.aws_region });
}

/** Read all stdin as a string */
async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// ── Register ──────────────────────────────────────────────────────────────────

export function registerNarrative(program: Command): void {
  const narrative = program
    .command("narrative")
    .description("Read or write task narrative content (S3)");

  // ── get ──────────────────────────────────────────────────────────────────

  narrative
    .command("get")
    .description("Print the narrative .md for a task to stdout")
    .requiredOption("--task-id <hex>", "Task ID (8-char hex)")
    .option("--fleet <file>", "fleet.yaml path", "fleet.yaml")
    .action(async (opts: { taskId: string; fleet: string }) => {
      const fleet = loadFleet(opts.fleet);
      const ledger = makeLedger(fleet);
      const store = makeNarrativeStore(fleet);

      const record = await ledger.getTask(opts.taskId);
      if (!record) {
        log.error(`Task not found: ${opts.taskId}`);
        process.exit(1);
      }

      const body = await store.getNarrative(record.task_s3_key);
      if (body === undefined) {
        log.warn(`Narrative not yet available for task ${opts.taskId} (key: ${record.task_s3_key})`);
        process.exit(1);
      }

      process.stdout.write(body);
    });

  // ── put ──────────────────────────────────────────────────────────────────

  narrative
    .command("put")
    .description("Write a narrative .md for a task from stdin")
    .requiredOption("--task-id <hex>", "Task ID (8-char hex)")
    .option("--event <name>", "Event name for local fallback filename (shipped|blocked)", "event")
    .option("--fleet <file>", "fleet.yaml path", "fleet.yaml")
    .action(async (opts: { taskId: string; event: string; fleet: string }) => {
      const fleet = loadFleet(opts.fleet);
      const ledger = makeLedger(fleet);
      const store = makeNarrativeStore(fleet);

      const record = await ledger.getTask(opts.taskId);
      if (!record) {
        log.error(`Task not found: ${opts.taskId}`);
        process.exit(1);
      }

      if (process.stdin.isTTY) {
        log.error("narrative put reads from stdin. Pipe or redirect the narrative content.");
        process.exit(1);
      }

      const body = await readStdin();
      if (!body.trim()) {
        log.error("stdin was empty — nothing to write.");
        process.exit(1);
      }

      const result = await store.putNarrative(record.task_s3_key, body, {
        taskId: opts.taskId,
        fallbackEvent: opts.event,
      });

      if (result.ok) {
        console.log(`Narrative written to s3://${fleet.delegation!.s3_bucket}/${record.task_s3_key}`);
      } else {
        log.warn(`S3 write failed. Narrative saved locally at ${result.fallback}`);
        log.warn("Retry the S3 write on the next heartbeat.");
        process.exit(2);
      }
    });
}
