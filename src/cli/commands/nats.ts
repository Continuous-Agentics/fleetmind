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
import { execFile } from "node:child_process";
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
    log.info("[nats] delegation not enabled in fleet.yaml — exiting cleanly.");
    process.exit(0);
  }
  if (!d.nats) {
    // Exit 0 so systemd path-activated units don't retry-loop when NATS
    // isn't configured. The unit is always written; the service self-quiesces.
    log.info("[nats] delegation.nats not configured in fleet.yaml — exiting cleanly.");
    process.exit(0);
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

// Wake an OpenClaw agent so it processes an inbound NATS delegation.
//
// History — what we had before this comment was written:
//
//   The original wakeAgent POSTed { action: "create_flow", goal: <msg> } to
//   /plugins/webhooks/nats-wake (the webhooks plugin route, authenticated via
//   OPENCLAW_HOOKS_TOKEN). That returned HTTP 200 + a real flowId — but the
//   resulting flow only ever landed in .openclaw/flows/registry.sqlite as
//   `status: queued`. Nothing actually woke the agent's main loop. Verified
//   via strace: writev to 127.0.0.1:18789 went out, gateway responded,
//   nothing executed. Result: subscriber acked DDB but the worker never
//   processed the task, never opened a Slack thread per the bot-reception
//   protocol, never published a ship event back to NATS. The whole
//   delegation primitive was broken end-to-end.
//
//   `openclaw agent --agent <id> --message <text>` is the OpenClaw primitive
//   that "Run[s] an agent turn via the Gateway" (per `openclaw agent --help`).
//   Verified on a live forge instance: returns a real run result with a
//   model call, response payload, and usage stats. This is what we want.
//
// One thing the subscriber HAS to get right that the previous code didn't:
// the openclaw CLI resolves its config from $HOME/.openclaw/openclaw.json.
// The systemd unit sets HOME=$WORKSPACE_DIR for the subscriber (so the
// subscriber's process.env already carries the right HOME). Passing process.env
// through to execFile preserves that — but if you spawn from a context where
// HOME is wrong, openclaw will read a different config and fail with "Unknown
// agent id <id>". That was the second part of why the old path was opaque.
//
// Non-blocking: fire and forget. We don't await the agent turn — the
// subscriber needs to return to processing the next NATS event. The agent's
// reply (Slack post, narrative write, `fleetmind task ship`) flows through
// its own side effects.
/**
 * Parse a Slack thread URL into its channel id + Slack-style timestamp.
 *
 * URL shape: `https://<workspace>.slack.com/archives/<CHANNEL_ID>/p<ts_compact>`
 *   - `<CHANNEL_ID>` — uppercase letters/digits (e.g. `C07GGJPQJCD`)
 *   - `<ts_compact>` — Slack's `<seconds><microseconds>` with the dot removed
 *     (e.g. `1780020261313409` → `1780020261.313409`)
 *
 * Returns null if the URL doesn't match (e.g. empty string, a non-Slack
 * URL, or a `/messages/` permalink shape). Caller decides what to do then.
 */
export function parseSlackThreadUrl(url: string): { channelId: string; threadTs: string } | null {
  if (!url) return null;
  const match = url.match(/\/archives\/([A-Z0-9]+)\/p(\d{7,})/);
  if (!match) return null;
  const channelId = match[1]!;
  const compact = match[2]!;
  // Last 6 digits are microseconds; everything before is seconds.
  const threadTs = `${compact.slice(0, -6)}.${compact.slice(-6)}`;
  return { channelId, threadTs };
}

/**
 * Build the OpenClaw session key for a specific Slack thread.
 *
 * Verified against a live conductor host's
 * `.openclaw/agents/<id>/sessions/sessions.json` — sessions are keyed by:
 *   `agent:<agentId>:slack:channel:<channel-lowercased>:thread:<dotted-ts>`
 *
 * Passing this as `--session-key` to `openclaw agent` routes the wake into
 * the same session that's actively chatting in that Slack thread, instead
 * of the agent's `:main` session (which is the default and was making
 * NATS-driven wakes invisible to live Slack conversations).
 */
function slackThreadSessionKey(agentId: string, channelId: string, threadTs: string): string {
  return `agent:${agentId}:slack:channel:${channelId.toLowerCase()}:thread:${threadTs}`;
}

function wakeAgent(
  agentId: string,
  message: string,
  opts?: { sessionKey?: string }
): void {
  const token = process.env.GATEWAY_TOKEN ?? process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    log.warn(`[nats] wakeAgent(${agentId}): no GATEWAY_TOKEN — skipping wake (set the env var via /etc/fleetmind or the systemd EnvironmentFile)`);
    return;
  }
  // Two timeouts are layered here. The openclaw CLI's own --timeout (default
  // 30s per `openclaw agent --help`) governs how long the CLI waits for the
  // gateway's WebSocket response before giving up. The execFile timeout
  // governs how long *we* wait before SIGTERM-ing the CLI subprocess. If
  // either fires while the agent turn is still running, the WS disconnects,
  // the gateway aborts the in-flight turn, and OpenClaw surfaces a
  // *misleading* "LLM request timed out — increase agents.defaults.timeoutSeconds"
  // (it isn't the LLM that timed out; it's the subscriber-side wrapper). So
  // both need to be larger than any reasonable agent turn for a bot-reception
  // flow (Slack post + external tool calls + write the artifact + post completion).
  // 10 minutes is generous but not unbounded.
  const turnTimeoutMs = 600_000;
  const args = ["agent", "--agent", agentId, "--message", message, "--timeout", String(turnTimeoutMs)];
  // Route into the specific Slack-thread session when the caller has one.
  // Without this, the wake hits the agent's `:main` session, invisible to
  // whatever Slack thread the agent is currently chatting in — the source of
  // "Conductor said the NATS event never made it" even when the subscriber
  // had already delivered it. See slackThreadSessionKey docstring.
  if (opts?.sessionKey) {
    args.push("--session-key", opts.sessionKey);
  }
  // Pass the gateway token explicitly. `process.env` already carries HOME
  // from the systemd unit (Environment=HOME=$WORKSPACE_DIR), which is what
  // the openclaw CLI needs to find the right openclaw.json + agent registry.
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCLAW_GATEWAY_TOKEN: token };
  const ocBin = process.env.OPENCLAW_BIN ?? "openclaw";
  execFile(ocBin, args, { timeout: turnTimeoutMs + 30_000, env }, (err) => {
    if (err) log.warn(`[nats] wakeAgent(${agentId}) failed: ${err.message}`);
  });
}


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

      // Both modes need a ledger:
      //   worker — acks incoming delegations
      //   pm     — signs off tasks on ship, records blocked state
      const ledger = makeLedger(fleet);

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

          // Worker mode: auto-ack inbound delegations via DDB + wake OpenClaw session.
          if (opts.mode === "worker" && event.event === "delegation") {
            // Wake the worker agent so it starts processing the delegation immediately.
            const workerId = opts.workerId ?? event.worker;
            if (workerId) {
              const msg = `NATS: Task ${event.task_id} delegated to you. Description: ${event.description ?? "(see DDB)"}`;
              wakeAgent(workerId, msg);
            }
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

          // PM mode: advance DDB lifecycle on worker terminal events.
          if (opts.mode === "pm") {
            // For ship + block we need the DDB record anyway — ship checks
            // `lifecycle` to decide auto-signoff, and both wake the PM via
            // the Slack-thread session derived from `delegation_thread`. Fetch
            // it ONCE here so we don't double-roundtrip later in the ship branch.
            //
            // Fail-safe: a missing record / fetch error means we can't route
            // the wake to a thread session (PM will land in :main), and ship
            // defaults to `requires-human-signoff` so we never auto-signoff
            // something we couldn't read.
            let taskRecord: Awaited<ReturnType<typeof ledger.getTask>> | undefined;
            if (event.event === "ship" || event.event === "block") {
              try {
                taskRecord = await ledger.getTask(event.task_id);
              } catch (err) {
                log.warn(`[nats] task ${event.task_id} getTask failed (PM wake will fall back to :main session; ship will default to requires-human-signoff): ${err}`);
              }
            }

            // Wake the OpenClaw PM session on ship/block events. Route into
            // the Slack thread session when `delegation_thread` is set so the
            // wake surfaces inside the live PM↔human conversation — instead
            // of vanishing into the agent's :main session (where it would be
            // invisible to whatever Slack thread the PM is actively in).
            if (event.event === "ship" || event.event === "block") {
              const pmAgentId = fleet.agents.list.find(a => a.orchestrator)?.id ?? "conductor";
              const msg = event.event === "ship"
                ? `NATS: Task ${event.task_id} shipped by ${event.worker}. ${event.message ?? ""}`
                : `NATS: Task ${event.task_id} blocked by ${event.worker}. ${event.reason ?? ""}`;
              // Prefer the DDB record's delegation_thread (authoritative), fall
              // back to anything the event carried (it's an optional field).
              const threadUrl = taskRecord?.delegation_thread ?? event.delegation_thread ?? "";
              const parsed = parseSlackThreadUrl(threadUrl);
              const sessionKey = parsed
                ? slackThreadSessionKey(pmAgentId, parsed.channelId, parsed.threadTs)
                : undefined;
              wakeAgent(pmAgentId, msg, sessionKey ? { sessionKey } : undefined);
            }

            if (event.event === "ship") {
              const lifecycle =
                (taskRecord?.lifecycle) ?? (event as unknown as Record<string, unknown>).lifecycle ?? "requires-human-signoff";

              if (lifecycle === "requires-human-signoff") {
                // Human sign-off required — do not auto-signoff.
                if (!opts.json) {
                  log.info(`[nats] task ${event.task_id} lifecycle=requires-human-signoff — skipping auto-signoff; awaiting human review`);
                } else {
                  process.stdout.write(JSON.stringify({
                    _type: "signoff_skipped",
                    task_id: event.task_id,
                    reason: "requires-human-signoff",
                  }) + "\n");
                }
              } else {
              // Lifecycle allows auto-signoff — PM transitions shipped → signed_off.
              try {
                await ledger.signoffTask(event.task_id, event.project);
                if (!opts.json) {
                  log.info(`[nats] ✓ task ${event.task_id} signed off in DDB (shipped→signed_off)`);
                } else {
                  process.stdout.write(JSON.stringify({
                    _type: "signoff_result",
                    task_id: event.task_id,
                    status: "signed_off",
                  }) + "\n");
                }
              } catch (err) {
                if (err instanceof TaskConditionError) {
                  log.warn(`[nats] task ${event.task_id} signoff condition error (already signed_off?): ${err.message}`);
                } else {
                  log.error(`[nats] task ${event.task_id} signoff failed: ${err}`);
                }
              }
              } // end else (auto-signoff)
            }

            if (event.event === "block") {
              // Worker is blocked — log for visibility; DDB already updated by worker.
              if (!opts.json) {
                const reasonSuffix = event.reason ? `: ${event.reason}` : "";
                log.warn(`[nats] task ${event.task_id} blocked by ${event.worker}${reasonSuffix}`);
              } else {
                process.stdout.write(JSON.stringify({
                  _type: "block_received",
                  task_id: event.task_id,
                  worker: event.worker,
                  reason: event.reason,
                }) + "\n");
              }
            }

            if (event.event === "progress") {
              if (!opts.json) {
                log.info(`[nats] task ${event.task_id} progress from ${event.worker}: ${event.message ?? "(no message)"}`);
              }
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
