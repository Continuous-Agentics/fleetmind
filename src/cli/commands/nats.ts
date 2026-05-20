/**
 * fleetmind nats — NATS transport management subcommands
 *
 * Usage:
 *   fleetmind nats subscribe --mode worker --worker-id <id>
 *   fleetmind nats subscribe --mode pm
 *   fleetmind nats progress --task-id <hex> --worker <id> --message <text> ...
 *   fleetmind nats publish --event delegation|ack|progress|ship|block --task-id <hex> ...
 *
 * Reads NATS connection config from fleet.yaml (delegation.nats).
 */

import { Command } from "commander";
import { resolveAndLoadFleet } from "../../config/loader.js";
import {
  subscribeTaskEvents,
  publishTaskEvent,
  type TaskEvent,
  type TaskEventType,
} from "../../transport/nats.js";
import { TaskLedger, TaskConditionError } from "../../runtime/delegation/ddb.js";
import { log } from "../../utils/log.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function getNatsConfig(fleet: ReturnType<typeof resolveAndLoadFleet>) {
  const d = fleet.delegation;
  if (!d?.enabled) {
    log.error("Delegation is not enabled in this fleet. Set delegation.enabled = true in fleet.yaml.");
    process.exit(1);
  }
  if (!d.nats) {
    log.error(
      "NATS is not configured for this fleet. Set delegation.nats in fleet.yaml and set delegation_transport to 'nats' or 'both'."
    );
    process.exit(1);
  }
  return d.nats;
}

function makeLedger(fleet: ReturnType<typeof resolveAndLoadFleet>): TaskLedger {
  const d = fleet.delegation;
  if (!d?.enabled || !d.table_name) {
    log.error("Delegation is not enabled in this fleet.");
    process.exit(1);
  }
  return new TaskLedger({ tableName: d.table_name, region: d.aws_region });
}

// ── Register ──────────────────────────────────────────────────────────────────

export function registerNats(program: Command): void {
  const nats = program
    .command("nats")
    .description("NATS transport — subscribe to task events or publish one-shot events")
    .addHelpText("after", `
Subcommands:
  subscribe   Long-running subscriber (worker: auto-ack delegations; pm: receive task lifecycle events)
  publish     One-shot event publisher (for testing / ad-hoc use)

Run \`fleetmind nats <subcommand> --help\` for examples.
`);

  // ── subscribe ─────────────────────────────────────────────────────────────

  nats
    .command("subscribe")
    .description("Subscribe to NATS task events (long-running)")
    .requiredOption(
      "--mode <mode>",
      "Subscriber mode: 'worker' (receives delegations, auto-acks) or 'pm' (receives all task events)"
    )
    .option("--worker-id <id>", "Worker agent ID — required when --mode worker")
    .option("--queue-group <name>", "NATS queue group (load-balanced multi-instance workers)")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--json", "Emit events as JSON lines instead of human-readable text")
    .addHelpText("after", `
Examples:
  # Worker: subscribe and auto-ack inbound delegations
  $ fleetmind nats subscribe --mode worker --worker-id daedalus

  # PM bot: subscribe to all task lifecycle events
  $ fleetmind nats subscribe --mode pm

  # Worker with queue group (multiple instances share the load)
  $ fleetmind nats subscribe --mode worker --worker-id daedalus --queue-group daedalus-workers

  # JSON output (pipe into jq or OpenClaw message handler)
  $ fleetmind nats subscribe --mode pm --json | jq 'select(.event == "ship")'
`)
    .action(async (opts: {
      mode: string;
      workerId?: string;
      queueGroup?: string;
      fleet?: string;
      json?: boolean;
    }) => {
      if (opts.mode !== "worker" && opts.mode !== "pm") {
        log.error("--mode must be 'worker' or 'pm'");
        process.exit(1);
      }
      if (opts.mode === "worker" && !opts.workerId) {
        log.error("--worker-id is required when --mode worker");
        process.exit(1);
      }

      const fleet = resolveAndLoadFleet(opts.fleet);
      const natsCfg = getNatsConfig(fleet);

      if (!opts.json) {
        log.info(`[nats] starting ${opts.mode} subscriber…`);
      }

      const ledger = opts.mode === "worker" ? makeLedger(fleet) : undefined;

      const cleanup = await subscribeTaskEvents(
        natsCfg,
        {
          mode: opts.mode as "worker" | "pm",
          worker_id: opts.workerId,
          queue_group: opts.queueGroup,
        },
        async (event, subject) => {
          if (opts.json) {
            process.stdout.write(JSON.stringify({ ...event, _subject: subject }) + "\n");
          } else {
            log.info(`[nats] ← ${event.event} on ${subject}: task=${event.task_id} project=${event.project} worker=${event.worker}`);
          }

          // Worker mode: auto-ack inbound delegations via DDB.
          if (opts.mode === "worker" && event.event === "delegation" && ledger) {
            try {
              await ledger.ackTask(event.task_id, event.worker, event.project);
              if (!opts.json) {
                log.info(`[nats] ✓ task ${event.task_id} acked in DDB (delegated→accepted)`);
              } else {
                process.stdout.write(JSON.stringify({
                  _type: "ack_result",
                  task_id: event.task_id,
                  status: "accepted",
                }) + "\n");
              }
            } catch (err) {
              if (err instanceof TaskConditionError) {
                log.warn(`[nats] task ${event.task_id} ack condition error (already accepted?): ${err.message}`);
              } else {
                log.error(`[nats] task ${event.task_id} ack failed: ${err}`);
              }
            }
          }

          // PM mode: receive worker events and verify / reconcile DDB state.
          if (opts.mode === "pm" && (event.event === "ship" || event.event === "block")) {
            // In pm mode we don't write DDB — workers already do that.
            // This subscriber acts as a push-based wake signal for the PM bot.
            // External orchestration (OpenClaw session, EventBridge) can hook
            // into this stream to trigger PM bot turns without polling.
            if (!opts.json) {
              log.info(`[nats] ↑ pm received ${event.event} for task ${event.task_id} — wake signal ready`);
            }
          }
        }
      );

      // Graceful shutdown on SIGINT / SIGTERM.
      process.on("SIGINT", async () => {
        if (!opts.json) log.info("[nats] shutting down…");
        await cleanup();
        process.exit(0);
      });
      process.on("SIGTERM", async () => {
        await cleanup();
        process.exit(0);
      });

      // Keep process alive.
      await new Promise<void>(() => {/* intentionally never resolves */});
    });

  // ── publish ───────────────────────────────────────────────────────────────

  nats
    .command("publish")
    .description("Publish a one-shot task event to NATS (testing / ad-hoc)")
    .requiredOption("--event <type>", "Event type: delegation | ack | progress | ship | block")
    .requiredOption("--task-id <hex>", "Task ID (8-char hex)")
    .requiredOption("--project <slug>", "Project slug")
    .requiredOption("--worker <id>", "Worker agent ID")
    .requiredOption("--delegated-by <id>", "PM bot agent ID")
    .option("--dod <text>", "Definition of done (included in delegation events)")
    .option("--description <text>", "Feature description (included in delegation events)")
    .option("--requestor <slack-uid>", "Slack user ID of the human requestor (included in delegation events)")
    .option("--tracker <url>", "Tracker link (included in delegation events)")
    .option("--message <text>", "Progress message (progress events)")
    .option("--reason <text>", "Free-form reason (block events)")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--json", "Output JSON confirmation")
    .addHelpText("after", `
Examples:
  # Publish a delegation event to a worker
  $ fleetmind nats publish --event delegation --task-id a1b2c3d4 \\
      --project my-project --worker daedalus --delegated-by ariadne \\
      --dod "All tests pass"

  # Publish a ship event
  $ fleetmind nats publish --event ship --task-id a1b2c3d4 \\
      --project my-project --worker daedalus --delegated-by ariadne
`)
    .action(async (opts: {
      event: string;
      taskId: string;
      project: string;
      worker: string;
      delegatedBy: string;
      dod?: string;
      description?: string;
      requestor?: string;
      tracker?: string;
      message?: string;
      reason?: string;
      fleet?: string;
      json?: boolean;
    }) => {
      const validEvents: TaskEventType[] = ["delegation", "ack", "progress", "ship", "block"];
      if (!validEvents.includes(opts.event as TaskEventType)) {
        log.error(`--event must be one of: ${validEvents.join(", ")}`);
        process.exit(1);
      }

      const fleet = resolveAndLoadFleet(opts.fleet);
      const natsCfg = getNatsConfig(fleet);

      const event: TaskEvent = {
        v: "1.0",
        event: opts.event as TaskEventType,
        task_id: opts.taskId,
        project: opts.project,
        worker: opts.worker,
        delegated_by: opts.delegatedBy,
        at: new Date().toISOString(),
        definition_of_done: opts.dod,
        description: opts.description,
        requestor: opts.requestor,
        tracker_link: opts.tracker,
        message: opts.message,
        reason: opts.reason,
      };

      await publishTaskEvent(natsCfg, event);

      if (opts.json) {
        console.log(JSON.stringify({ published: true, subject: `${natsCfg.subject_prefix}.${opts.event}`, event }));
      } else {
        log.info(`[nats] published ${opts.event} for task ${opts.taskId}`);
      }
    });

  // ── progress ───────────────────────────────────────────────────────

  nats
    .command("progress")
    .description("Send a mid-task progress update to the PM bot via NATS")
    .requiredOption("--task-id <hex>", "Task ID (8-char hex)")
    .requiredOption("--worker <id>", "Worker agent ID")
    .requiredOption("--project <slug>", "Project slug")
    .requiredOption("--delegated-by <id>", "PM bot agent ID")
    .requiredOption("--message <text>", "Progress update message")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--json", "Output JSON confirmation")
    .addHelpText("after", `
Examples:
  # Send a progress update mid-task
  $ fleetmind nats progress \\
      --task-id a1b2c3d4 --worker daedalus --project fleetmind-next \\
      --delegated-by ariadne \\
      --message "PR open, waiting on review from requestor"
`)
    .action(async (opts: {
      taskId: string;
      worker: string;
      project: string;
      delegatedBy: string;
      message: string;
      fleet?: string;
      json?: boolean;
    }) => {
      const fleet = resolveAndLoadFleet(opts.fleet);
      const natsCfg = getNatsConfig(fleet);

      const event: TaskEvent = {
        v: "1.0",
        event: "progress",
        task_id: opts.taskId,
        project: opts.project,
        worker: opts.worker,
        delegated_by: opts.delegatedBy,
        at: new Date().toISOString(),
        message: opts.message,
      };

      await publishTaskEvent(natsCfg, event);

      if (opts.json) {
        console.log(JSON.stringify({ published: true, task_id: opts.taskId, message: opts.message }));
      } else {
        log.info(`[nats] progress update sent for task ${opts.taskId}`);
      }
    });
}
