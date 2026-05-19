/**
 * fleetmind query — enumerate tasks from the ledger
 *
 * Usage:
 *   fleetmind query pending  [--worker <id>] [--project <slug>] [--limit <n>] [--json]
 *   fleetmind query shipped  [--project <slug>] [--limit <n>] [--json]
 *   fleetmind query merged   [--project <slug>] [--limit <n>] [--json]
 *   fleetmind query stale    [--older-than <duration>] [--limit <n>] [--json]
 *   fleetmind query all      [--project <slug>] [--status <status>] [--limit <n>] [--json]
 *
 * Durations for --older-than: Go-style (e.g. 1h, 30m, 24h, 1d).
 */

import { Command } from "commander";
import { resolveAndLoadFleet } from "../../config/loader.js";
import { TaskLedger } from "../../runtime/delegation/ddb.js";
import { TaskStatus } from "../../runtime/delegation/types.js";
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

/**
 * Parse a Go-style duration string into milliseconds.
 * Supports: m (minutes), h (hours), d (days). e.g. "30m", "1h", "24h", "1d".
 */
export function parseDuration(s: string): number {
  const match = s.match(/^(\d+(?:\.\d+)?)(m|h|d)$/);
  if (!match) {
    throw new Error(
      `Invalid duration '${s}'. Use Go-style durations like 30m, 1h, 24h, 1d.`
    );
  }
  const value = parseFloat(match[1]);
  const unit = match[2];
  switch (unit) {
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default:  throw new Error(`Unknown duration unit '${unit}'`);
  }
}

/** Return an ISO timestamp that is `ms` milliseconds before now */
function msAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ── Register ──────────────────────────────────────────────────────────────────

export function registerQuery(program: Command): void {
  const query = program
    .command("query")
    .description("Query the task ledger (pending, shipped, merged, stale, all)")
    .addHelpText('after', `
Subcommands:
  pending   List delegated (in-flight) tasks
  shipped   List shipped tasks awaiting signoff
  merged    List merged tasks
  stale     List tasks that haven't progressed past an age threshold
  all       Query all tasks with optional filters

Run \`fleetmind query <subcommand> --help\` for examples.
`);

  // ── pending ──────────────────────────────────────────────────────────────

  query
    .command("pending")
    .description("List delegated (pending) tasks")
    .option("--worker <id>", "Filter by worker agent ID (post-filter)")
    .option("--project <slug>", "Filter by project slug")
    .option("--limit <n>", "Maximum results", "50")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--region <region>", "AWS region override")
    .option("--json", "Output JSON")
    .addHelpText('after', `
Examples:
  # List all pending tasks across all projects
  $ fleetmind query pending

  # List pending tasks for a specific worker
  $ fleetmind query pending --worker forge

  # List pending tasks in a specific project
  $ fleetmind query pending --project website-rewrite

  # Output as JSON for scripting
  $ fleetmind query pending --json
`)
    .action(async (opts: {
      worker?: string;
      project?: string;
      limit: string;
      fleet?: string;
      region?: string;
      json?: boolean;
    }) => {
      if (opts.region) process.env["AWS_REGION"] = opts.region;
      const fleet = resolveAndLoadFleet(opts.fleet);
      const ledger = makeLedger(fleet);
      const limit = parseInt(opts.limit, 10);

      let items = opts.project
        ? await ledger.queryByProjectStatus({ project: opts.project, status: "delegated", limit, ascending: false })
        : await ledger.queryByStatus({ status: "delegated", limit, ascending: false });

      if (opts.worker) {
        items = items.filter((t) => t.worker === opts.worker);
      }

      const output = { pending: items };
      console.log(opts.json ? JSON.stringify(output, null, 2) : formatTable(items));
    });

  // ── shipped ───────────────────────────────────────────────────────────────

  query
    .command("shipped")
    .description("List shipped tasks")
    .option("--project <slug>", "Filter by project slug")
    .option("--limit <n>", "Maximum results", "20")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--region <region>", "AWS region override")
    .option("--json", "Output JSON")
    .addHelpText('after', `
Examples:
  # List all recently shipped tasks
  $ fleetmind query shipped

  # List shipped tasks for a specific project
  $ fleetmind query shipped --project website-rewrite

  # Output as JSON
  $ fleetmind query shipped --json
`)
    .action(async (opts: {
      project?: string;
      limit: string;
      fleet?: string;
      region?: string;
      json?: boolean;
    }) => {
      if (opts.region) process.env["AWS_REGION"] = opts.region;
      const fleet = resolveAndLoadFleet(opts.fleet);
      const ledger = makeLedger(fleet);
      const limit = parseInt(opts.limit, 10);

      const items = opts.project
        ? await ledger.queryByProjectStatus({ project: opts.project, status: "shipped", limit, ascending: false })
        : await ledger.queryByStatus({ status: "shipped", limit, ascending: false });

      const output = { shipped: items };
      console.log(opts.json ? JSON.stringify(output, null, 2) : formatTable(items));
    });

  // ── merged ───────────────────────────────────────────────────────────────

  query
    .command("merged")
    .description("List merged tasks")
    .option("--project <slug>", "Filter by project slug")
    .option("--limit <n>", "Maximum results", "20")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--region <region>", "AWS region override")
    .option("--json", "Output JSON")
    .addHelpText('after', `
Examples:
  # List all merged tasks
  $ fleetmind query merged

  # List merged tasks for a specific project
  $ fleetmind query merged --project website-rewrite

  # Output as JSON
  $ fleetmind query merged --json
`)
    .action(async (opts: {
      project?: string;
      limit: string;
      fleet?: string;
      region?: string;
      json?: boolean;
    }) => {
      if (opts.region) process.env["AWS_REGION"] = opts.region;
      const fleet = resolveAndLoadFleet(opts.fleet);
      const ledger = makeLedger(fleet);
      const limit = parseInt(opts.limit, 10);

      const items = opts.project
        ? await ledger.queryByProjectStatus({ project: opts.project, status: "merged", limit, ascending: false })
        : await ledger.queryByStatus({ status: "merged", limit, ascending: false });

      const output = { merged: items };
      console.log(opts.json ? JSON.stringify(output, null, 2) : formatTable(items));
    });

  // ── stale ─────────────────────────────────────────────────────────────────

  query
    .command("stale")
    .description("List tasks that have not progressed past the given age threshold")
    .option("--older-than <duration>", "Tasks older than this duration are stale (e.g. 1h, 30m, 1d)", "24h")
    .option("--limit <n>", "Maximum results per status", "50")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--region <region>", "AWS region override")
    .option("--json", "Output JSON")
    .addHelpText('after', `
Examples:
  # Find tasks that haven't progressed in more than 24 hours (default)
  $ fleetmind query stale

  # Find tasks stale for more than 2 hours
  $ fleetmind query stale --older-than 2h

  # Find tasks stale for more than 30 minutes
  $ fleetmind query stale --older-than 30m

  # Output as JSON for alerting scripts
  $ fleetmind query stale --older-than 1h --json
`)
    .action(async (opts: {
      olderThan: string;
      limit: string;
      fleet?: string;
      region?: string;
      json?: boolean;
    }) => {
      let olderThanMs: number;
      try {
        olderThanMs = parseDuration(opts.olderThan);
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }

      if (opts.region) process.env["AWS_REGION"] = opts.region;
      const fleet = resolveAndLoadFleet(opts.fleet);
      const ledger = makeLedger(fleet);
      const limit = parseInt(opts.limit, 10);
      const cutoff = msAgo(olderThanMs);

      const [staleDelegated, staleShipped] = await Promise.all([
        ledger.queryByStatus({ status: "delegated", olderThan: cutoff, limit, ascending: true }),
        ledger.queryByStatus({ status: "shipped",   olderThan: cutoff, limit, ascending: true }),
      ]);

      const output = {
        stale_delegated: staleDelegated,
        stale_shipped: staleShipped,
        threshold: opts.olderThan,
        cutoff_at: cutoff,
        queried_at: new Date().toISOString(),
      };
      console.log(opts.json ? JSON.stringify(output, null, 2) : formatStale(output));
    });

  // ── all ───────────────────────────────────────────────────────────────────

  query
    .command("all")
    .description("Query all tasks, optionally filtered by project and/or status")
    .option("--project <slug>", "Filter by project slug")
    .option("--status <status>", "Filter by status (delegated|accepted|shipped|merged|blocked|abandoned|signed_off)")
    .option("--limit <n>", "Maximum results", "50")
    .option("--fleet <path-or-name>", "fleet.yaml path or fleet name")
    .option("--region <region>", "AWS region override")
    .option("--json", "Output JSON")
    .addHelpText('after', `
Examples:
  # List all tasks in a project across every status
  $ fleetmind query all --project website-rewrite

  # List all blocked tasks across the fleet
  $ fleetmind query all --status blocked

  # List blocked tasks in a specific project
  $ fleetmind query all --project api-refactor --status blocked

  # Output as JSON for downstream processing
  $ fleetmind query all --project website-rewrite --json
`)
    .action(async (opts: {
      project?: string;
      status?: string;
      limit: string;
      fleet?: string;
      region?: string;
      json?: boolean;
    }) => {
      if (opts.region) process.env["AWS_REGION"] = opts.region;
      const fleet = resolveAndLoadFleet(opts.fleet);
      const ledger = makeLedger(fleet);
      const limit = parseInt(opts.limit, 10);

      let items;

      if (opts.project && opts.status) {
        // GSI1: ProjectStatusIndex — most efficient
        // Support comma-separated status values (e.g. "delegated,accepted,shipped")
        const statuses = opts.status.split(",").map((s) => s.trim()).filter(Boolean) as TaskStatus[];
        if (statuses.length === 1) {
          items = await ledger.queryByProjectStatus({
            project: opts.project,
            status: statuses[0],
            limit,
            ascending: false,
          });
        } else {
          const results = await Promise.all(
            statuses.map((s) =>
              ledger.queryByProjectStatus({ project: opts.project!, status: s, limit, ascending: false })
            )
          );
          items = results.flat();
        }
      } else if (opts.status) {
        // GSI2: StatusIndex — cross-project
        // Support comma-separated status values (e.g. "delegated,accepted,shipped,blocked")
        const statuses = opts.status.split(",").map((s) => s.trim()).filter(Boolean) as TaskStatus[];
        if (statuses.length === 1) {
          items = await ledger.queryByStatus({
            status: statuses[0],
            limit,
            ascending: false,
          });
        } else {
          const results = await Promise.all(
            statuses.map((s) => ledger.queryByStatus({ status: s, limit, ascending: false }))
          );
          items = results.flat();
        }
      } else if (opts.project) {
        // All statuses for a project — query each known status and merge
        log.warn("Querying all statuses for a project requires multiple GSI1 queries (no table scan).");
        const statuses: TaskStatus[] = ["delegated", "accepted", "shipped", "signed_off", "merged", "blocked", "abandoned"];
        const results = await Promise.all(
          statuses.map((s) =>
            ledger.queryByProjectStatus({ project: opts.project!, status: s, limit, ascending: false })
          )
        );
        items = results.flat();
      } else {
        // No filters — warn about cost
        log.warn("No --project or --status given. This queries each status index separately (potentially expensive).");
        const statuses: TaskStatus[] = ["delegated", "accepted", "shipped", "signed_off", "merged", "blocked", "abandoned"];
        const results = await Promise.all(
          statuses.map((s) => ledger.queryByStatus({ status: s, limit, ascending: false }))
        );
        items = results.flat();
      }

      const output = { items };
      console.log(opts.json ? JSON.stringify(output, null, 2) : formatTable(items));
    });
}

// ── Formatters ────────────────────────────────────────────────────────────────

interface TaskRow {
  task_id: string;
  project: string;
  status: string;
  delegated_at: string;
  worker: string;
}

function formatTable(rows: TaskRow[]): string {
  if (rows.length === 0) return "(no results)";
  return rows
    .map((r) => `${r.task_id}  ${r.status.padEnd(12)}  ${r.project.padEnd(20)}  ${r.worker.padEnd(20)}  ${r.delegated_at}`)
    .join("\n");
}

function formatStale(output: {
  stale_delegated: TaskRow[];
  stale_shipped: TaskRow[];
  threshold: string;
  cutoff_at: string;
}): string {
  const lines: string[] = [`Stale tasks (older than ${output.threshold}, cutoff: ${output.cutoff_at})`];
  if (output.stale_delegated.length > 0) {
    lines.push("\nDelegated (not yet accepted):");
    lines.push(formatTable(output.stale_delegated));
  }
  if (output.stale_shipped.length > 0) {
    lines.push("\nShipped (awaiting signoff/merge):");
    lines.push(formatTable(output.stale_shipped));
  }
  if (output.stale_delegated.length === 0 && output.stale_shipped.length === 0) {
    lines.push("(no stale tasks)");
  }
  return lines.join("\n");
}
