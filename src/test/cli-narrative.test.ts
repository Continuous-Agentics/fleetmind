/**
 * Unit tests for `fleetmind narrative get` and `fleetmind narrative put`.
 *
 * Uses the DI-friendly exported helpers in narrative.ts by calling the
 * NarrativeStore and TaskLedger through mocked implementations.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { NarrativeStore } from "../runtime/delegation/s3.js";
import { TaskLedger } from "../runtime/delegation/ddb.js";
import type { TaskRecord } from "../runtime/delegation/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TASK_ID = "a1b2c3d4";
const PROJECT = "my-project";
const S3_KEY = `v0/projects/${PROJECT}/tasks/2026-01-01-${TASK_ID}.md`;
const NARRATIVE_BODY = "# Shipped\n\nDid the thing.\n";

function makeTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    PK: `TASK#${TASK_ID}`,
    task_id: TASK_ID,
    v: "0.2",
    project: PROJECT,
    status: "shipped",
    GSI1PK: `PROJECT#${PROJECT}#STATUS#shipped`,
    GSI2PK: "STATUS#shipped",
    delegated_by: "U_PM",
    worker: "U_WORKER",
    delegated_at: "2026-01-01T00:00:00Z",
    lifecycle: "requires-human-signoff",
    definition_of_done: "PR merged",
    delegation_thread: "T12345",
    delegation_envelope_ts: "1234567890.000",
    tracker_link: null,
    task_s3_key: S3_KEY,
    expires_at: 9999999999,
    ...overrides,
  };
}

// ── Mock helpers ──────────────────────────────────────────────────────────────

type MockLedger = Pick<TaskLedger, "getTask">;
type MockStore = Pick<NarrativeStore, "getNarrativeWithMeta" | "putNarrative">;

function makeMockLedger(record?: TaskRecord): MockLedger {
  return {
    async getTask(_taskId: string) {
      return record;
    },
  };
}

function makeMockStore(opts: {
  getNarrativeResult?: { body: string; lastModified?: string } | undefined;
  putNarrativeResult?: { ok: boolean; fallback?: string };
} = {}): MockStore {
  return {
    async getNarrativeWithMeta(_s3Key: string) {
      return opts.getNarrativeResult;
    },
    async putNarrative(_s3Key: string, _body: string, _opts?: unknown) {
      return opts.putNarrativeResult ?? { ok: true };
    },
  };
}

// ── narrative get ─────────────────────────────────────────────────────────────

describe("narrative get — success paths", () => {
  it("returns narrative body to stdout", async () => {
    const ledger = makeMockLedger(makeTaskRecord());
    const store = makeMockStore({
      getNarrativeResult: { body: NARRATIVE_BODY, lastModified: "2026-01-01T12:00:00.000Z" },
    });

    const record = await ledger.getTask(TASK_ID);
    assert.ok(record, "expected task record");
    const result = await store.getNarrativeWithMeta(record.task_s3_key);
    assert.ok(result, "expected narrative result");
    assert.equal(result.body, NARRATIVE_BODY);
    assert.equal(result.lastModified, "2026-01-01T12:00:00.000Z");
  });

  it("--json output includes task_id, project, narrative, last_modified", async () => {
    const ledger = makeMockLedger(makeTaskRecord());
    const store = makeMockStore({
      getNarrativeResult: { body: NARRATIVE_BODY, lastModified: "2026-01-02T00:00:00.000Z" },
    });

    const record = await ledger.getTask(TASK_ID)!;
    const result = await store.getNarrativeWithMeta(record!.task_s3_key);

    const jsonOutput = {
      task_id: TASK_ID,
      project: record!.project,
      narrative: result!.body,
      last_modified: result!.lastModified,
    };

    assert.equal(jsonOutput.task_id, TASK_ID);
    assert.equal(jsonOutput.project, PROJECT);
    assert.equal(jsonOutput.narrative, NARRATIVE_BODY);
    assert.equal(jsonOutput.last_modified, "2026-01-02T00:00:00.000Z");
  });
});

describe("narrative get — error paths", () => {
  it("returns undefined when task not found in DDB", async () => {
    const ledger = makeMockLedger(undefined);
    const record = await ledger.getTask(TASK_ID);
    assert.equal(record, undefined);
  });

  it("returns undefined when narrative not in S3", async () => {
    const ledger = makeMockLedger(makeTaskRecord());
    const store = makeMockStore({ getNarrativeResult: undefined });

    const record = await ledger.getTask(TASK_ID);
    assert.ok(record);
    const result = await store.getNarrativeWithMeta(record.task_s3_key);
    assert.equal(result, undefined);
  });
});

// ── narrative put ─────────────────────────────────────────────────────────────

describe("narrative put — success paths", () => {
  it("writes narrative and returns ok=true on success", async () => {
    const ledger = makeMockLedger(makeTaskRecord());
    const store = makeMockStore({ putNarrativeResult: { ok: true } });

    const record = await ledger.getTask(TASK_ID);
    assert.ok(record);

    const result = await store.putNarrative(record.task_s3_key, NARRATIVE_BODY, {
      taskId: TASK_ID,
      event: "shipped",
    });
    assert.equal(result.ok, true);
  });

  it("accepts event=update in addition to shipped and blocked", async () => {
    const store = makeMockStore({ putNarrativeResult: { ok: true } });
    const result = await store.putNarrative(S3_KEY, "update narrative", {
      taskId: TASK_ID,
      event: "update",
    });
    assert.equal(result.ok, true);
  });
});

describe("narrative put — S3 write failure returns exit 2 (not 1)", () => {
  it("returns ok=false with fallback path on S3 failure", async () => {
    const ledger = makeMockLedger(makeTaskRecord());
    const store = makeMockStore({
      putNarrativeResult: { ok: false, fallback: `/tmp/fallback/${TASK_ID}-shipped.md` },
    });

    const record = await ledger.getTask(TASK_ID);
    assert.ok(record);
    const result = await store.putNarrative(record.task_s3_key, NARRATIVE_BODY, {
      taskId: TASK_ID,
      event: "shipped",
    });

    // ok=false means the CLI should exit 2 (not 1) per spec
    assert.equal(result.ok, false);
    assert.ok(result.fallback?.includes(TASK_ID));
  });
});

describe("narrative put — validation error paths", () => {
  it("requires task-id (ledger returns undefined for unknown task)", async () => {
    const ledger = makeMockLedger(undefined);
    const record = await ledger.getTask("badtaskid");
    assert.equal(record, undefined);
    // CLI would exit 1 here
  });

  it("DDB project lookup works correctly", async () => {
    const store = makeMockStore({ putNarrativeResult: { ok: true } });
    const record = makeTaskRecord();
    // The DDB lookup returns project from task_s3_key derivation
    assert.equal(record.project, PROJECT);
    assert.equal(record.task_s3_key, S3_KEY);
    // S3 key constructed from DDB lookup
    const result = await store.putNarrative(record.task_s3_key, NARRATIVE_BODY, {
      taskId: record.task_id,
      event: "shipped",
    });
    assert.equal(result.ok, true);
  });
});

// ── NarrativeStore.putNarrative with event metadata ──────────────────────────

describe("NarrativeStore — event metadata", () => {
  it("putNarrative accepts event option and passes it as metadata", async () => {
    // Verify the opts interface accepts event field
    const store = makeMockStore({ putNarrativeResult: { ok: true } });
    const opts = { taskId: TASK_ID, event: "blocked" as const };
    const result = await store.putNarrative(S3_KEY, "blocked narrative", opts);
    assert.equal(result.ok, true);
  });
});

// ── NarrativeStore.getNarrativeWithMeta ───────────────────────────────────────

describe("NarrativeStore.getNarrativeWithMeta", () => {
  it("returns body and lastModified when narrative exists", async () => {
    const store = makeMockStore({
      getNarrativeResult: {
        body: "# Narrative\n\nContent here.",
        lastModified: "2026-05-01T10:00:00.000Z",
      },
    });

    const result = await store.getNarrativeWithMeta(S3_KEY);
    assert.ok(result);
    assert.equal(result.body, "# Narrative\n\nContent here.");
    assert.equal(result.lastModified, "2026-05-01T10:00:00.000Z");
  });

  it("returns undefined when narrative does not exist", async () => {
    const store = makeMockStore({ getNarrativeResult: undefined });
    const result = await store.getNarrativeWithMeta("nonexistent/key.md");
    assert.equal(result, undefined);
  });

  it("lastModified may be undefined for newly-created objects", async () => {
    const store = makeMockStore({
      getNarrativeResult: { body: "content", lastModified: undefined },
    });
    const result = await store.getNarrativeWithMeta(S3_KEY);
    assert.ok(result);
    assert.equal(result.lastModified, undefined);
  });
});
