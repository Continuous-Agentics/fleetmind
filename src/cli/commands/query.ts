/**
 * fleetmind query — enumerate tasks from the ledger
 *
 * Usage:
 *   fleetmind query pending  [--project <slug>] [--limit <n>] [--threshold <minutes>]
 *   fleetmind query merged   [--project <slug>] [--limit <n>]
 *   fleetmind query stale    [--project <slug>] [--delegated-threshold <min>] [--accepted-threshold <min>]
 *
 * All output is JSON (machine-friendly for skill use; human-readable via jq).
 */

import { Command } from "commander";
import { loadFleet } from "../../config/loader.js";
import { TaskLedger } from "../../runtime/delegation/ddb.js";
import { TaskStatus } from "../../runtime/delegation/types.js";
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

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function queryStatus(
  ledger: TaskLedger,
  status: TaskStatus,
  opts: { project?: string; olderThan?: string; limit?: number }
) {
  if (opts.project) {
    return ledger.queryByProjectStatus({
      project: opts.project,
      status,
      olderThan: opts.olderThan,
      limit: opts.limit,
      ascending: true,
    });
  }
  return ledger.queryByStatus({
    status,
    olderThan: opts.olderThan,
    limit: opts.limit,
    ascending: false,
  });
}

// ── Register ──────────────────────────────────────────────────────────────────

export function registerQuery(program: Command): void {
  const query = program
    .command("query")
    .description("Query the task ledger (pending, merged, stale)");

  // ── pending ──────────────────────────────────────────────────────────────

  query
    .command("pending")
    .description("List tasks in delegated or accepted state")
    .option("--project <slug>", "Filter by project slug")
    .option("--limit <n>", "Maximum results", "50")
    .option("--fleet <file>", "fleet.yaml path", "fleet.yaml")
    .action(async (opts: { project?: string; limit: string; fleet: string }) => {
      const fleet = loadFleet(opts.fleet);
      const ledger = makeLedger(fleet);
      const limit = parseInt(opts.limit, 10);

      const [delegated, accepted] = await Promise.all([
        queryStatus(ledger, "delegated", { project: opts.project, limit }),
        queryStatus(ledger, "accepted", { project: opts.project, limit }),
      ]);

      console.log(JSON.stringify({ delegated, accepted }, null, 2));
    });

  // ── merged ───────────────────────────────────────────────────────────────

  query
    .command("merged")
    .description("List recently merged tasks (for planning context)")
    .option("--project <slug>", "Filter by project slug")
    .option("--limit <n>", "Maximum results", "20")
    .option("--fleet <file>", "fleet.yaml path", "fleet.yaml")
    .action(async (opts: { project?: string; limit: string; fleet: string }) => {
      const fleet = loadFleet(opts.fleet);
      const ledger = makeLedger(fleet);
      const limit = parseInt(opts.limit, 10);

      const merged = await queryStatus(ledger, "merged", {
        project: opts.project,
        limit,
      });

      console.log(JSON.stringify({ merged }, null, 2));
    });

  // ── stale ─────────────────────────────────────────────────────────────────

  query
    .command("stale")
    .description("List tasks past their deadline (for heartbeat escalation)")
    .option("--project <slug>", "Filter by project slug")
    .option("--delegated-threshold <minutes>", "Minutes after which a delegated task is stale", "10")
    .option("--accepted-threshold <minutes>", "Minutes after which an accepted task is stale", "60")
    .option("--limit <n>", "Maximum results per status", "50")
    .option("--fleet <file>", "fleet.yaml path", "fleet.yaml")
    .action(async (opts: {
      project?: string;
      delegatedThreshold: string;
      acceptedThreshold: string;
      limit: string;
      fleet: string;
    }) => {
      const fleet = loadFleet(opts.fleet);
      const ledger = makeLedger(fleet);
      const limit = parseInt(opts.limit, 10);
      const delegatedCutoff = minutesAgo(parseInt(opts.delegatedThreshold, 10));
      const acceptedCutoff = minutesAgo(parseInt(opts.acceptedThreshold, 10));

      const [staleDelegated, staleAccepted] = await Promise.all([
        queryStatus(ledger, "delegated", {
          project: opts.project,
          olderThan: delegatedCutoff,
          limit,
        }),
        queryStatus(ledger, "accepted", {
          project: opts.project,
          olderThan: acceptedCutoff,
          limit,
        }),
      ]);

      const result = {
        stale_delegated: staleDelegated,
        stale_accepted: staleAccepted,
        thresholds: {
          delegated_minutes: parseInt(opts.delegatedThreshold, 10),
          accepted_minutes: parseInt(opts.acceptedThreshold, 10),
          queried_at: new Date().toISOString(),
        },
      };

      console.log(JSON.stringify(result, null, 2));
    });
}
