/**
 * fleetmind narrative — read/write task narrative content to S3
 *
 * Usage:
 *   fleetmind narrative get --task-id <hex> [--json]
 *   fleetmind narrative put --task-id <hex> --event <shipped|blocked|update>  (reads stdin)
 *
 * The s3_key is resolved from the DynamoDB task record (single GetItem call).
 * Requires delegation.enabled + delegation.table_name + delegation.s3_bucket.
 */

import { Command } from "commander";
import { resolveAndLoadFleet } from "../../config/loader.js";
import { TaskLedger } from "../../runtime/delegation/ddb.js";
import { NarrativeStore } from "../../runtime/delegation/s3.js";
import { log } from "../../utils/log.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLedger(fleet: ReturnType<typeof resolveAndLoadFleet>): TaskLedger {
  const d = fleet.delegation;
  if (!d?.enabled || !d.table_name) {
    log.error("Delegation is not enabled. Set delegation.enabled = true and delegation.table_name in fleet.yaml.");
    process.exit(1);
  }
  return new TaskLedger({ tableName: d.table_name, region: d.aws_region });
}

function makeNarrativeStore(fleet: ReturnType<typeof resolveAndLoadFleet>): NarrativeStore {
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
    .description("Read or write task narrative content (S3)")
    .addHelpText('after', `
Subcommands:
  get   Print the narrative markdown for a task to stdout
  put   Write a narrative from stdin

Run \`fleetmind narrative <subcommand> --help\` for examples.
`);

  // ── get ──────────────────────────────────────────────────────────────────

  narrative
    .command("get")
    .description("Print the narrative .md for a task to stdout")
    .requiredOption("--task-id <hex>", "Task ID (8-char hex)")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--region <region>", "AWS region override")
    .option("--json", "Output JSON object with task_id, project, narrative, last_modified")
    .addHelpText('after', `
Examples:
  # Print the narrative for a task to stdout
  $ fleetmind narrative get --task-id a1b2c3d4

  # Get narrative as JSON (includes task_id, project, last_modified)
  $ fleetmind narrative get --task-id a1b2c3d4 --json
`)
    .action(async (opts: { taskId: string; fleet?: string; region?: string; json?: boolean }) => {
      if (opts.region) process.env["AWS_REGION"] = opts.region;
      const fleet = resolveAndLoadFleet(opts.fleet);
      const ledger = makeLedger(fleet);
      const store = makeNarrativeStore(fleet);

      const record = await ledger.getTask(opts.taskId);
      if (!record) {
        log.error(`Task not found: ${opts.taskId}`);
        process.exit(1);
      }

      const result = await store.getNarrativeWithMeta(record.task_s3_key);
      if (result === undefined) {
        log.warn(`Narrative not yet available for task ${opts.taskId} (key: ${record.task_s3_key})`);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({
          task_id: opts.taskId,
          project: record.project,
          narrative: result.body,
          last_modified: result.lastModified,
        }, null, 2));
      } else {
        process.stdout.write(result.body);
      }
    });

  // ── put ──────────────────────────────────────────────────────────────────

  narrative
    .command("put")
    .description("Write a narrative .md for a task from stdin")
    .requiredOption("--task-id <hex>", "Task ID (8-char hex)")
    .requiredOption("--event <event>", "Event type: shipped|blocked|update")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--region <region>", "AWS region override")
    .addHelpText('after', `
Examples:
  # Write a narrative from a markdown file (pipe into stdin)
  $ cat narrative.md | fleetmind narrative put --task-id a1b2c3d4 --event shipped

  # Write a narrative for a blocked task
  $ cat blocked-note.md | fleetmind narrative put --task-id a1b2c3d4 --event blocked

  # Write a progress update narrative
  $ echo "## Progress\\nCompleted auth module" | fleetmind narrative put --task-id a1b2c3d4 --event update
`)
    .action(async (opts: { taskId: string; event: string; fleet?: string; region?: string }) => {
      // Validate event value
      const validEvents = ["shipped", "blocked", "update"];
      if (!validEvents.includes(opts.event)) {
        log.error(`Invalid --event value '${opts.event}'. Must be one of: ${validEvents.join(", ")}`);
        process.exit(1);
      }

      if (opts.region) process.env["AWS_REGION"] = opts.region;
      const fleet = resolveAndLoadFleet(opts.fleet);
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
        event: opts.event,
      });

      if (result.ok) {
        console.log(`Narrative written to s3://${fleet.delegation!.s3_bucket}/${record.task_s3_key}`);
      } else {
        log.warn(`S3 write failed. Narrative saved locally at ${result.fallback}`);
        log.warn("Retry the S3 write on the next heartbeat.");
        // Exit 2 as spec requires — the bot-reception skill checks $? -eq 2
        process.exit(2);
      }
    });
}
