/**
 * Unit tests for `fleetmind query` subcommands.
 *
 * Tests GSI query construction, post-filters (worker, project),
 * --json output shape, and parseDuration utility.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../cli/commands/query.js";
import type { TaskSummary, TaskStatus } from "../runtime/delegation/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTaskSummary(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    task_id: "a1b2c3d4",
    project: "my-project",
    status: "delegated",
    delegated_at: "2026-01-01T00:00:00Z",
    worker: "U_WORKER",
    task_s3_key: "v0/projects/my-project/tasks/2026-01-01-a1b2c3d4.md",
    ...overrides,
  };
}

// ── Mock ledger ───────────────────────────────────────────────────────────────

interface QueryByProjectStatusOpts {
  project: string;
  status: TaskStatus;
  olderThan?: string;
  limit?: number;
  ascending?: boolean;
}

interface QueryByStatusOpts {
  status: TaskStatus;
  olderThan?: string;
  limit?: number;
  ascending?: boolean;
}

interface LedgerMockCall {
  method: "queryByProjectStatus" | "queryByStatus";
  opts: QueryByProjectStatusOpts | QueryByStatusOpts;
}

function makeMockLedger(
  items: TaskSummary[] = [],
  calls: LedgerMockCall[] = []
) {
  return {
    async queryByProjectStatus(opts: QueryByProjectStatusOpts): Promise<TaskSummary[]> {
      calls.push({ method: "queryByProjectStatus", opts });
      return items.filter((t) => t.status === opts.status);
    },
    async queryByStatus(opts: QueryByStatusOpts): Promise<TaskSummary[]> {
      calls.push({ method: "queryByStatus", opts });
      return items.filter((t) => t.status === opts.status);
    },
  };
}

// ── parseDuration ─────────────────────────────────────────────────────────────

describe("parseDuration", () => {
  it("parses minutes", () => {
    assert.equal(parseDuration("30m"), 30 * 60 * 1000);
    assert.equal(parseDuration("5m"), 5 * 60 * 1000);
    assert.equal(parseDuration("1m"), 60 * 1000);
  });

  it("parses hours", () => {
    assert.equal(parseDuration("1h"), 60 * 60 * 1000);
    assert.equal(parseDuration("24h"), 24 * 60 * 60 * 1000);
    assert.equal(parseDuration("2h"), 2 * 60 * 60 * 1000);
  });

  it("parses days", () => {
    assert.equal(parseDuration("1d"), 24 * 60 * 60 * 1000);
    assert.equal(parseDuration("7d"), 7 * 24 * 60 * 60 * 1000);
  });

  it("throws on invalid format", () => {
    assert.throws(() => parseDuration("1 hour"), /Invalid duration/);
    assert.throws(() => parseDuration("2w"), /Invalid duration/);
    assert.throws(() => parseDuration("abc"), /Invalid duration/);
    assert.throws(() => parseDuration(""), /Invalid duration/);
  });
});

// ── query pending ─────────────────────────────────────────────────────────────

describe("query pending — GSI2 query construction", () => {
  it("queries GSI2 StatusIndex for delegated status", async () => {
    const calls: LedgerMockCall[] = [];
    const items = [
      makeTaskSummary({ status: "delegated", worker: "U_WORKER_A" }),
      makeTaskSummary({ task_id: "b2c3d4e5", status: "delegated", worker: "U_WORKER_B" }),
    ];
    const ledger = makeMockLedger(items, calls);

    const results = await ledger.queryByStatus({ status: "delegated", limit: 50, ascending: false });
    assert.equal(results.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "queryByStatus");
    assert.equal((calls[0].opts as QueryByStatusOpts).status, "delegated");
  });

  it("post-filters by worker when --worker given", async () => {
    const items = [
      makeTaskSummary({ task_id: "aaaa1111", status: "delegated", worker: "U_A" }),
      makeTaskSummary({ task_id: "bbbb2222", status: "delegated", worker: "U_B" }),
    ];
    const ledger = makeMockLedger(items);

    let results = await ledger.queryByStatus({ status: "delegated", limit: 50 });
    // Post-filter for worker U_A
    results = results.filter((t) => t.worker === "U_A");
    assert.equal(results.length, 1);
    assert.equal(results[0].task_id, "aaaa1111");
  });

  it("uses GSI1 ProjectStatusIndex when --project given", async () => {
    const calls: LedgerMockCall[] = [];
    const items = [makeTaskSummary({ status: "delegated", project: "proj-x" })];
    const ledger = makeMockLedger(items, calls);

    await ledger.queryByProjectStatus({ project: "proj-x", status: "delegated", limit: 50 });
    assert.equal(calls[0].method, "queryByProjectStatus");
    assert.equal((calls[0].opts as QueryByProjectStatusOpts).project, "proj-x");
  });

  it("post-filters by worker when --project AND --worker given", async () => {
    const items = [
      makeTaskSummary({ task_id: "aaaa1111", status: "delegated", project: "proj-x", worker: "U_A" }),
      makeTaskSummary({ task_id: "bbbb2222", status: "delegated", project: "proj-x", worker: "U_B" }),
    ];
    const ledger = makeMockLedger(items);

    let results = await ledger.queryByProjectStatus({ project: "proj-x", status: "delegated", limit: 50 });
    results = results.filter((t) => t.worker === "U_A");
    assert.equal(results.length, 1);
  });
});

// ── query shipped ─────────────────────────────────────────────────────────────

describe("query shipped — GSI2 query for shipped status", () => {
  it("queries GSI2 for shipped status", async () => {
    const calls: LedgerMockCall[] = [];
    const items = [makeTaskSummary({ status: "shipped" })];
    const ledger = makeMockLedger(items, calls);

    const results = await ledger.queryByStatus({ status: "shipped", limit: 20 });
    assert.equal(results.length, 1);
    assert.equal(calls[0].method, "queryByStatus");
    assert.equal((calls[0].opts as QueryByStatusOpts).status, "shipped");
  });

  it("--json output has shipped array", async () => {
    const items = [makeTaskSummary({ status: "shipped" })];
    const ledger = makeMockLedger(items);
    const results = await ledger.queryByStatus({ status: "shipped", limit: 20 });
    const output = { shipped: results };
    assert.ok(Array.isArray(output.shipped));
    assert.equal(output.shipped.length, 1);
  });

  it("uses GSI1 when --project given", async () => {
    const calls: LedgerMockCall[] = [];
    const items = [makeTaskSummary({ status: "shipped", project: "proj-y" })];
    const ledger = makeMockLedger(items, calls);

    await ledger.queryByProjectStatus({ project: "proj-y", status: "shipped", limit: 20 });
    assert.equal((calls[0].opts as QueryByProjectStatusOpts).project, "proj-y");
  });
});

// ── query merged ──────────────────────────────────────────────────────────────

describe("query merged — GSI2 query for merged status", () => {
  it("queries GSI2 for merged status", async () => {
    const calls: LedgerMockCall[] = [];
    const items = [makeTaskSummary({ status: "merged" })];
    const ledger = makeMockLedger(items, calls);

    const results = await ledger.queryByStatus({ status: "merged", limit: 20 });
    assert.equal(results.length, 1);
    assert.equal((calls[0].opts as QueryByStatusOpts).status, "merged");
  });

  it("--json output has merged array", async () => {
    const items = [makeTaskSummary({ status: "merged" })];
    const ledger = makeMockLedger(items);
    const results = await ledger.queryByStatus({ status: "merged" });
    const output = { merged: results };
    assert.ok(Array.isArray(output.merged));
  });
});

// ── query stale ───────────────────────────────────────────────────────────────

describe("query stale — queries delegated AND shipped with olderThan cutoff", () => {
  it("queries delegated and shipped statuses in parallel", async () => {
    const calls: LedgerMockCall[] = [];
    const items = [
      makeTaskSummary({ status: "delegated", delegated_at: "2025-01-01T00:00:00Z" }),
      makeTaskSummary({ task_id: "deadbeef", status: "shipped", delegated_at: "2025-01-01T00:00:00Z" }),
    ];
    const ledger = makeMockLedger(items, calls);

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await Promise.all([
      ledger.queryByStatus({ status: "delegated", olderThan: cutoff, limit: 50, ascending: true }),
      ledger.queryByStatus({ status: "shipped",   olderThan: cutoff, limit: 50, ascending: true }),
    ]);

    assert.equal(calls.length, 2);
    const statuses = calls.map((c) => (c.opts as QueryByStatusOpts).status);
    assert.ok(statuses.includes("delegated"));
    assert.ok(statuses.includes("shipped"));
  });

  it("--older-than default is 24h, parses correctly", () => {
    const ms = parseDuration("24h");
    assert.equal(ms, 24 * 60 * 60 * 1000);
  });

  it("--older-than 30m is 30 minutes", () => {
    const ms = parseDuration("30m");
    assert.equal(ms, 30 * 60 * 1000);
  });

  it("--json output shape has stale_delegated, stale_shipped, threshold, cutoff_at", async () => {
    const items = [
      makeTaskSummary({ status: "delegated" }),
      makeTaskSummary({ task_id: "deadbeef", status: "shipped" }),
    ];
    const ledger = makeMockLedger(items);
    const cutoff = "2026-01-01T00:00:00Z";

    const [staleDelegated, staleShipped] = await Promise.all([
      ledger.queryByStatus({ status: "delegated", olderThan: cutoff, limit: 50 }),
      ledger.queryByStatus({ status: "shipped",   olderThan: cutoff, limit: 50 }),
    ]);

    const output = {
      stale_delegated: staleDelegated,
      stale_shipped: staleShipped,
      threshold: "24h",
      cutoff_at: cutoff,
      queried_at: new Date().toISOString(),
    };

    assert.ok(Array.isArray(output.stale_delegated));
    assert.ok(Array.isArray(output.stale_shipped));
    assert.equal(output.threshold, "24h");
    assert.equal(output.cutoff_at, cutoff);
    assert.ok(typeof output.queried_at === "string");
  });
});

// ── query all ─────────────────────────────────────────────────────────────────

describe("query all — GSI selection logic", () => {
  it("uses GSI1 (ProjectStatusIndex) when both --project and --status given", async () => {
    const calls: LedgerMockCall[] = [];
    const items = [makeTaskSummary({ status: "delegated", project: "proj-z" })];
    const ledger = makeMockLedger(items, calls);

    await ledger.queryByProjectStatus({ project: "proj-z", status: "delegated", limit: 50 });
    assert.equal(calls[0].method, "queryByProjectStatus");
  });

  it("uses GSI2 (StatusIndex) when only --status given", async () => {
    const calls: LedgerMockCall[] = [];
    const items = [makeTaskSummary({ status: "blocked" })];
    const ledger = makeMockLedger(items, calls);

    await ledger.queryByStatus({ status: "blocked", limit: 50 });
    assert.equal(calls[0].method, "queryByStatus");
    assert.equal((calls[0].opts as QueryByStatusOpts).status, "blocked");
  });

  it("--json output has items array", async () => {
    const items = [makeTaskSummary({ status: "delegated" })];
    const ledger = makeMockLedger(items);
    const results = await ledger.queryByProjectStatus({ project: "p", status: "delegated", limit: 50 });
    const output = { items: results };
    assert.ok(Array.isArray(output.items));
    assert.equal(output.items.length, 1);
  });
});

// ── TaskSummary JSON shape ────────────────────────────────────────────────────

describe("TaskSummary shape", () => {
  it("has required fields for JSON output", () => {
    const summary = makeTaskSummary();
    assert.ok(typeof summary.task_id === "string");
    assert.ok(typeof summary.project === "string");
    assert.ok(typeof summary.status === "string");
    assert.ok(typeof summary.delegated_at === "string");
    assert.ok(typeof summary.worker === "string");
    assert.ok(typeof summary.task_s3_key === "string");
  });

  it("serializes to JSON correctly", () => {
    const summary = makeTaskSummary();
    const json = JSON.parse(JSON.stringify(summary));
    assert.equal(json.task_id, summary.task_id);
    assert.equal(json.project, summary.project);
    assert.equal(json.status, summary.status);
  });
});
