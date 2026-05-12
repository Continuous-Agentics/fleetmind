/**
 * Unit tests for `fleetmind task` subcommands.
 *
 * Uses dependency injection (TaskLedgerLike) instead of module mocking —
 * no real DynamoDB connection required.
 *
 * Covers:
 *   - create: success path, duplicate task_id (condition failed), --json shape
 *   - get: found, not found
 *   - ack: success, condition failed (already accepted), --json shape
 *   - ship: success, condition failed (not yet accepted)
 *   - block: success, condition failed (already terminal)
 *   - signoff: success, condition failed (not shipped)
 *   - abandon: success, condition failed (already merged)
 *   - merge: success, condition failed (not signed_off/shipped)
 *   - set-nag: success, task not found (condition failed)
 *   - DDB key construction: PK, GSI1PK, GSI2PK correct for new items
 *   - State machine: can't ship without ack, can't signoff without ship
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { TaskConditionError } from "../runtime/delegation/ddb.js";
import type { TaskRecord } from "../runtime/delegation/types.js";
import { gsi1pk, gsi2pk, taskPK } from "../runtime/delegation/types.js";

import {
  type TaskLedgerLike,
  createTask,
  getTask,
  ackTask,
  shipTask,
  blockTask,
  unblockTask,
  signoffTask,
  abandonTask,
  mergeTask,
  setNagTask,
} from "../cli/commands/task.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = "2026-05-12T18:00:00Z";

function makeRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    PK: taskPK("a1b2c3d4"),
    task_id: "a1b2c3d4",
    v: "0.2",
    project: "website-rewrite",
    status: "delegated",
    GSI1PK: gsi1pk("website-rewrite", "delegated"),
    GSI2PK: gsi2pk("delegated"),
    delegated_by: "U_PM_BOT",
    worker: "U_WORKER",
    delegated_at: NOW,
    lifecycle: "requires-human-signoff",
    definition_of_done: "The widget renders.",
    delegation_thread: "https://example.com/thread",
    delegation_envelope_ts: "1234567890.000000",
    tracker_link: null,
    task_s3_key: "v0/projects/website-rewrite/tasks/2026-05-12-a1b2c3d4.md",
    expires_at: Math.floor(Date.now() / 1000) + 86400 * 365,
    ...overrides,
  };
}

// ── Mock TaskLedger factory ───────────────────────────────────────────────────

interface MockLedgerState {
  records: Map<string, TaskRecord>;
  calls: Array<{ method: string; args: unknown[] }>;
}

function makeMockLedger(initial?: TaskRecord[]): { ledger: TaskLedgerLike; state: MockLedgerState } {
  const state: MockLedgerState = {
    records: new Map((initial ?? []).map((r) => [r.task_id, r])),
    calls: [],
  };

  const ledger: TaskLedgerLike = {
    async createTask(input) {
      state.calls.push({ method: "createTask", args: [input] });
      if (state.records.has(input.task_id)) {
        throw new TaskConditionError(`Task ${input.task_id} already exists`);
      }
      const record = makeRecord({
        task_id: input.task_id,
        PK: taskPK(input.task_id),
        project: input.project,
        worker: input.worker,
        delegated_by: input.delegated_by,
        status: "delegated",
        GSI1PK: gsi1pk(input.project, "delegated"),
        GSI2PK: gsi2pk("delegated"),
        definition_of_done: input.definition_of_done,
        delegation_thread: input.delegation_thread,
        delegation_envelope_ts: input.delegation_envelope_ts,
        tracker_link: input.tracker_link ?? null,
        lifecycle: input.lifecycle ?? "requires-human-signoff",
      });
      state.records.set(input.task_id, record);
      return record;
    },

    async getTask(taskId) {
      state.calls.push({ method: "getTask", args: [taskId] });
      return state.records.get(taskId);
    },

    async ackTask(taskId, worker, project) {
      state.calls.push({ method: "ackTask", args: [taskId, worker, project] });
      const record = state.records.get(taskId);
      if (!record || record.status !== "delegated") {
        throw new TaskConditionError(`ack condition failed for ${taskId}`);
      }
      state.records.set(taskId, {
        ...record,
        status: "accepted",
        accepted_at: NOW,
        GSI1PK: gsi1pk(record.project, "accepted"),
        GSI2PK: gsi2pk("accepted"),
      });
    },

    async shipTask(taskId, worker, project) {
      state.calls.push({ method: "shipTask", args: [taskId, worker, project] });
      const record = state.records.get(taskId);
      if (!record || record.status !== "accepted") {
        throw new TaskConditionError(`ship condition failed for ${taskId}`);
      }
      state.records.set(taskId, {
        ...record,
        status: "shipped",
        shipped_at: NOW,
        GSI1PK: gsi1pk(record.project, "shipped"),
        GSI2PK: gsi2pk("shipped"),
      });
    },

    async blockTask(taskId, worker, project) {
      state.calls.push({ method: "blockTask", args: [taskId, worker, project] });
      const record = state.records.get(taskId);
      if (!record || !["delegated", "accepted"].includes(record.status)) {
        throw new TaskConditionError(`block condition failed for ${taskId}`);
      }
      state.records.set(taskId, {
        ...record,
        status: "blocked",
        blocked_at: NOW,
        GSI1PK: gsi1pk(record.project, "blocked"),
        GSI2PK: gsi2pk("blocked"),
      });
    },

    async unblockTask(taskId, worker, reason, project) {
      state.calls.push({ method: "unblockTask", args: [taskId, worker, reason, project] });
      const record = state.records.get(taskId);
      if (!record || record.status !== "blocked") {
        throw new TaskConditionError(`unblock condition failed for ${taskId}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { blocked_at, ...rest } = record;
      const updated: TaskRecord = {
        ...rest,
        status: "accepted",
        unblocked_at: NOW,
        GSI1PK: gsi1pk(record.project, "accepted"),
        GSI2PK: gsi2pk("accepted"),
      };
      if (reason) updated.unblocked_reason = reason;
      state.records.set(taskId, updated);
    },

    async signoffTask(taskId, project) {
      state.calls.push({ method: "signoffTask", args: [taskId, project] });
      const record = state.records.get(taskId);
      if (!record || record.status !== "shipped") {
        throw new TaskConditionError(`signoff condition failed for ${taskId}`);
      }
      state.records.set(taskId, {
        ...record,
        status: "signed_off",
        signed_off_at: NOW,
        GSI1PK: gsi1pk(record.project, "signed_off"),
        GSI2PK: gsi2pk("signed_off"),
      });
    },

    async abandonTask(taskId, project) {
      state.calls.push({ method: "abandonTask", args: [taskId, project] });
      const record = state.records.get(taskId);
      if (!record || ["merged", "abandoned"].includes(record.status)) {
        throw new TaskConditionError(`abandon condition failed for ${taskId}`);
      }
      state.records.set(taskId, {
        ...record,
        status: "abandoned",
        abandoned_at: NOW,
        GSI1PK: gsi1pk(record.project, "abandoned"),
        GSI2PK: gsi2pk("abandoned"),
      });
    },

    async mergeTask(taskId, project) {
      state.calls.push({ method: "mergeTask", args: [taskId, project] });
      const record = state.records.get(taskId);
      if (!record || !["shipped", "signed_off"].includes(record.status)) {
        throw new TaskConditionError(`merge condition failed for ${taskId}`);
      }
      state.records.set(taskId, {
        ...record,
        status: "merged",
        merged_at: NOW,
        GSI1PK: gsi1pk(record.project, "merged"),
        GSI2PK: gsi2pk("merged"),
      });
    },

    async setNag(taskId) {
      state.calls.push({ method: "setNag", args: [taskId] });
      const record = state.records.get(taskId);
      if (!record) {
        throw new TaskConditionError(`set-nag: task not found: ${taskId}`);
      }
      state.records.set(taskId, { ...record, last_nag_at: NOW });
    },
  };

  return { ledger, state };
}

// ── Tests: create ─────────────────────────────────────────────────────────────

describe("createTask", () => {
  test("success path — returns a TaskRecord with correct shape", async () => {
    const { ledger, state } = makeMockLedger();
    const record = await createTask(
      {
        project: "website-rewrite",
        worker: "U_WORKER",
        delegatedBy: "U_PM_BOT",
        dod: "Widget renders.",
        thread: "https://slack.com/t/1",
        envelopeTs: "1234567890.000000",
        fleet: "fleet.yaml",
        taskId: "a1b2c3d4",
      },
      ledger
    );

    assert.equal(record.task_id, "a1b2c3d4");
    assert.equal(record.project, "website-rewrite");
    assert.equal(record.status, "delegated");
    assert.equal(record.worker, "U_WORKER");
    assert.equal(state.calls[0]?.method, "createTask");
  });

  test("DDB key construction — PK, GSI1PK, GSI2PK populated correctly", async () => {
    const { ledger } = makeMockLedger();
    const record = await createTask(
      {
        project: "my-proj",
        worker: "W1",
        delegatedBy: "PM1",
        dod: "Done.",
        thread: "https://t",
        envelopeTs: "ts",
        fleet: "fleet.yaml",
        taskId: "deadbeef",
      },
      ledger
    );

    assert.equal(record.PK, "TASK#deadbeef");
    assert.equal(record.GSI1PK, "PROJECT#my-proj#STATUS#delegated");
    assert.equal(record.GSI2PK, "STATUS#delegated");
  });

  test("duplicate task_id — throws TaskConditionError", async () => {
    const existing = makeRecord({ task_id: "a1b2c3d4" });
    const { ledger } = makeMockLedger([existing]);
    await assert.rejects(
      () =>
        createTask(
          {
            project: "website-rewrite",
            worker: "U_WORKER",
            delegatedBy: "U_PM_BOT",
            dod: "Widget renders.",
            thread: "https://t",
            envelopeTs: "ts",
            fleet: "fleet.yaml",
            taskId: "a1b2c3d4",
          },
          ledger
        ),
      TaskConditionError
    );
  });

  test("--json output shape includes task_id and status", async () => {
    const { ledger } = makeMockLedger();
    const record = await createTask(
      {
        project: "p",
        worker: "w",
        delegatedBy: "pm",
        dod: "done",
        thread: "t",
        envelopeTs: "ts",
        fleet: "fleet.yaml",
        taskId: "ffffffff",
        json: true,
      },
      ledger
    );
    // JSON output: the record itself has task_id and status
    assert.ok("task_id" in record);
    assert.ok("status" in record);
    assert.equal(record.status, "delegated");
  });
});

// ── Tests: get ────────────────────────────────────────────────────────────────

describe("getTask", () => {
  test("returns record when found", async () => {
    const existing = makeRecord();
    const { ledger } = makeMockLedger([existing]);
    const result = await getTask({ taskId: "a1b2c3d4", fleet: "fleet.yaml" }, ledger);
    assert.ok(result);
    assert.equal(result.task_id, "a1b2c3d4");
  });

  test("returns undefined when not found", async () => {
    const { ledger } = makeMockLedger();
    const result = await getTask({ taskId: "00000000", fleet: "fleet.yaml" }, ledger);
    assert.equal(result, undefined);
  });
});

// ── Tests: ack ────────────────────────────────────────────────────────────────

describe("ackTask", () => {
  test("success — delegated→accepted", async () => {
    const rec = makeRecord({ status: "delegated" });
    const { ledger, state } = makeMockLedger([rec]);
    await ackTask({ taskId: "a1b2c3d4", worker: "U_WORKER", fleet: "fleet.yaml" }, ledger);
    const updated = state.records.get("a1b2c3d4");
    assert.equal(updated?.status, "accepted");
  });

  test("condition failed — already accepted → throws TaskConditionError (exit 2)", async () => {
    const rec = makeRecord({ status: "accepted" });
    const { ledger } = makeMockLedger([rec]);
    await assert.rejects(
      () => ackTask({ taskId: "a1b2c3d4", worker: "U_WORKER", fleet: "fleet.yaml" }, ledger),
      TaskConditionError
    );
  });

  test("--json output shape", async () => {
    const rec = makeRecord({ status: "delegated" });
    const { ledger } = makeMockLedger([rec]);
    // No exception = success; JSON shape is built in the Commander handler, not the pure fn
    await assert.doesNotReject(
      () => ackTask({ taskId: "a1b2c3d4", worker: "U_WORKER", fleet: "fleet.yaml", json: true }, ledger)
    );
  });
});

// ── Tests: ship ───────────────────────────────────────────────────────────────

describe("shipTask", () => {
  test("success — accepted→shipped", async () => {
    const rec = makeRecord({ status: "accepted" });
    const { ledger, state } = makeMockLedger([rec]);
    await shipTask({ taskId: "a1b2c3d4", worker: "U_WORKER", fleet: "fleet.yaml" }, ledger);
    assert.equal(state.records.get("a1b2c3d4")?.status, "shipped");
  });

  test("condition failed — not accepted (delegated) → TaskConditionError", async () => {
    const rec = makeRecord({ status: "delegated" });
    const { ledger } = makeMockLedger([rec]);
    await assert.rejects(
      () => shipTask({ taskId: "a1b2c3d4", worker: "U_WORKER", fleet: "fleet.yaml" }, ledger),
      TaskConditionError
    );
  });

  test("state machine: cannot ship without ack", async () => {
    const rec = makeRecord({ status: "delegated" });
    const { ledger } = makeMockLedger([rec]);
    // Ship without ack → condition error
    await assert.rejects(
      () => shipTask({ taskId: "a1b2c3d4", worker: "U_WORKER", fleet: "fleet.yaml" }, ledger),
      TaskConditionError
    );
  });
});

// ── Tests: block ──────────────────────────────────────────────────────────────

describe("blockTask", () => {
  test("success — delegated→blocked", async () => {
    const rec = makeRecord({ status: "delegated" });
    const { ledger, state } = makeMockLedger([rec]);
    await blockTask({ taskId: "a1b2c3d4", worker: "U_WORKER", fleet: "fleet.yaml" }, ledger);
    assert.equal(state.records.get("a1b2c3d4")?.status, "blocked");
  });

  test("success — accepted→blocked", async () => {
    const rec = makeRecord({ status: "accepted" });
    const { ledger, state } = makeMockLedger([rec]);
    await blockTask({ taskId: "a1b2c3d4", worker: "U_WORKER", fleet: "fleet.yaml" }, ledger);
    assert.equal(state.records.get("a1b2c3d4")?.status, "blocked");
  });

  test("condition failed — shipped task cannot be blocked", async () => {
    const rec = makeRecord({ status: "shipped" });
    const { ledger } = makeMockLedger([rec]);
    await assert.rejects(
      () => blockTask({ taskId: "a1b2c3d4", worker: "U_WORKER", fleet: "fleet.yaml" }, ledger),
      TaskConditionError
    );
  });
});


// ── Tests: unblock ───────────────────────────────────────────────────────────

describe("unblockTask", () => {
  test("happy path — blocked→accepted with reason", async () => {
    const rec = makeRecord({ status: "blocked", blocked_at: NOW });
    const { ledger, state } = makeMockLedger([rec]);
    await unblockTask(
      { taskId: "a1b2c3d4", worker: "U_WORKER", reason: "auth restored", fleet: "fleet.yaml" },
      ledger
    );
    const updated = state.records.get("a1b2c3d4")!;
    assert.equal(updated.status, "accepted");
    assert.equal(updated.unblocked_at, NOW);
    assert.equal(updated.unblocked_reason, "auth restored");
    assert.equal(updated.blocked_at, undefined);
    assert.equal(updated.GSI1PK, gsi1pk("website-rewrite", "accepted"));
    assert.equal(updated.GSI2PK, gsi2pk("accepted"));
  });

  test("happy path — blocked→accepted without reason", async () => {
    const rec = makeRecord({ status: "blocked", blocked_at: NOW });
    const { ledger, state } = makeMockLedger([rec]);
    await unblockTask(
      { taskId: "a1b2c3d4", worker: "U_WORKER", fleet: "fleet.yaml" },
      ledger
    );
    const updated = state.records.get("a1b2c3d4")!;
    assert.equal(updated.status, "accepted");
    assert.equal(updated.unblocked_at, NOW);
    assert.equal(updated.unblocked_reason, undefined);
    assert.equal(updated.blocked_at, undefined);
  });

  test("condition failed — task in accepted state (not blocked)", async () => {
    const rec = makeRecord({ status: "accepted" });
    const { ledger } = makeMockLedger([rec]);
    await assert.rejects(
      () => unblockTask({ taskId: "a1b2c3d4", worker: "U_WORKER", fleet: "fleet.yaml" }, ledger),
      TaskConditionError
    );
  });

  test("condition failed — task in shipped state", async () => {
    const rec = makeRecord({ status: "shipped" });
    const { ledger } = makeMockLedger([rec]);
    await assert.rejects(
      () => unblockTask({ taskId: "a1b2c3d4", worker: "U_WORKER", fleet: "fleet.yaml" }, ledger),
      TaskConditionError
    );
  });

  test("missing task-id — condition failed (task not in records)", async () => {
    const { ledger } = makeMockLedger();
    await assert.rejects(
      () => unblockTask({ taskId: "00000000", worker: "U_WORKER", fleet: "fleet.yaml" }, ledger),
      TaskConditionError
    );
  });

  test("--json output shape — resolves without error", async () => {
    const rec = makeRecord({ status: "blocked", blocked_at: NOW });
    const { ledger } = makeMockLedger([rec]);
    await assert.doesNotReject(
      () => unblockTask({ taskId: "a1b2c3d4", worker: "U_WORKER", fleet: "fleet.yaml", json: true }, ledger)
    );
  });

  test("GSI keys updated correctly (project from existing record)", async () => {
    const rec = makeRecord({ status: "blocked", blocked_at: NOW, project: "website-rewrite" });
    const { ledger, state } = makeMockLedger([rec]);
    await unblockTask(
      { taskId: "a1b2c3d4", worker: "U_WORKER", reason: "dep installed", fleet: "fleet.yaml" },
      ledger
    );
    const updated = state.records.get("a1b2c3d4")!;
    assert.equal(updated.GSI1PK, "PROJECT#website-rewrite#STATUS#accepted");
    assert.equal(updated.GSI2PK, "STATUS#accepted");
  });
});

// ── Tests: signoff ────────────────────────────────────────────────────────────

describe("signoffTask", () => {
  test("success — shipped→signed_off", async () => {
    const rec = makeRecord({ status: "shipped" });
    const { ledger, state } = makeMockLedger([rec]);
    await signoffTask({ taskId: "a1b2c3d4", fleet: "fleet.yaml" }, ledger);
    assert.equal(state.records.get("a1b2c3d4")?.status, "signed_off");
  });

  test("condition failed — not shipped (delegated) → TaskConditionError", async () => {
    const rec = makeRecord({ status: "delegated" });
    const { ledger } = makeMockLedger([rec]);
    await assert.rejects(
      () => signoffTask({ taskId: "a1b2c3d4", fleet: "fleet.yaml" }, ledger),
      TaskConditionError
    );
  });

  test("state machine: cannot signoff without ship", async () => {
    const rec = makeRecord({ status: "accepted" });
    const { ledger } = makeMockLedger([rec]);
    await assert.rejects(
      () => signoffTask({ taskId: "a1b2c3d4", fleet: "fleet.yaml" }, ledger),
      TaskConditionError
    );
  });
});

// ── Tests: abandon ────────────────────────────────────────────────────────────

describe("abandonTask", () => {
  test("success — delegated→abandoned", async () => {
    const rec = makeRecord({ status: "delegated" });
    const { ledger, state } = makeMockLedger([rec]);
    await abandonTask({ taskId: "a1b2c3d4", fleet: "fleet.yaml" }, ledger);
    assert.equal(state.records.get("a1b2c3d4")?.status, "abandoned");
  });

  test("condition failed — merged task cannot be abandoned", async () => {
    const rec = makeRecord({ status: "merged" });
    const { ledger } = makeMockLedger([rec]);
    await assert.rejects(
      () => abandonTask({ taskId: "a1b2c3d4", fleet: "fleet.yaml" }, ledger),
      TaskConditionError
    );
  });
});

// ── Tests: merge ──────────────────────────────────────────────────────────────

describe("mergeTask", () => {
  test("success — shipped→merged", async () => {
    const rec = makeRecord({ status: "shipped" });
    const { ledger, state } = makeMockLedger([rec]);
    await mergeTask({ taskId: "a1b2c3d4", fleet: "fleet.yaml" }, ledger);
    assert.equal(state.records.get("a1b2c3d4")?.status, "merged");
  });

  test("success — signed_off→merged", async () => {
    const rec = makeRecord({ status: "signed_off" });
    const { ledger, state } = makeMockLedger([rec]);
    await mergeTask({ taskId: "a1b2c3d4", fleet: "fleet.yaml" }, ledger);
    assert.equal(state.records.get("a1b2c3d4")?.status, "merged");
  });

  test("condition failed — delegated task cannot be merged", async () => {
    const rec = makeRecord({ status: "delegated" });
    const { ledger } = makeMockLedger([rec]);
    await assert.rejects(
      () => mergeTask({ taskId: "a1b2c3d4", fleet: "fleet.yaml" }, ledger),
      TaskConditionError
    );
  });
});

// ── Tests: set-nag ────────────────────────────────────────────────────────────

describe("setNagTask", () => {
  test("success — sets last_nag_at on an existing task", async () => {
    const rec = makeRecord({ status: "shipped" });
    const { ledger, state } = makeMockLedger([rec]);
    await setNagTask({ taskId: "a1b2c3d4", fleet: "fleet.yaml" }, ledger);
    const updated = state.records.get("a1b2c3d4");
    assert.ok(updated?.last_nag_at, "last_nag_at should be set");
  });

  test("idempotent — calling twice is fine", async () => {
    const rec = makeRecord({ status: "shipped" });
    const { ledger, state } = makeMockLedger([rec]);
    await setNagTask({ taskId: "a1b2c3d4", fleet: "fleet.yaml" }, ledger);
    await setNagTask({ taskId: "a1b2c3d4", fleet: "fleet.yaml" }, ledger);
    assert.equal(state.calls.filter((c) => c.method === "setNag").length, 2);
  });

  test("condition failed — task not found (TaskConditionError)", async () => {
    const { ledger } = makeMockLedger(); // empty
    await assert.rejects(
      () => setNagTask({ taskId: "00000000", fleet: "fleet.yaml" }, ledger),
      TaskConditionError
    );
  });
});

// ── Tests: full state machine walkthrough ─────────────────────────────────────

describe("state machine — full lifecycle", () => {
  test("create → ack → ship → signoff → merge succeeds", async () => {
    const { ledger, state } = makeMockLedger();

    // create
    await createTask(
      {
        project: "proj",
        worker: "W",
        delegatedBy: "PM",
        dod: "Build X",
        thread: "t",
        envelopeTs: "ts",
        fleet: "fleet.yaml",
        taskId: "cafebabe",
      },
      ledger
    );
    assert.equal(state.records.get("cafebabe")?.status, "delegated");

    // ack
    await ackTask({ taskId: "cafebabe", worker: "W", fleet: "fleet.yaml" }, ledger);
    assert.equal(state.records.get("cafebabe")?.status, "accepted");

    // ship
    await shipTask({ taskId: "cafebabe", worker: "W", fleet: "fleet.yaml" }, ledger);
    assert.equal(state.records.get("cafebabe")?.status, "shipped");

    // set-nag (PM nags about shipped task)
    await setNagTask({ taskId: "cafebabe", fleet: "fleet.yaml" }, ledger);
    assert.ok(state.records.get("cafebabe")?.last_nag_at);

    // signoff
    await signoffTask({ taskId: "cafebabe", fleet: "fleet.yaml" }, ledger);
    assert.equal(state.records.get("cafebabe")?.status, "signed_off");

    // merge
    await mergeTask({ taskId: "cafebabe", fleet: "fleet.yaml" }, ledger);
    assert.equal(state.records.get("cafebabe")?.status, "merged");
  });

  test("create → ack → block (accepted→blocked)", async () => {
    const { ledger, state } = makeMockLedger();

    await createTask(
      {
        project: "proj",
        worker: "W",
        delegatedBy: "PM",
        dod: "Build X",
        thread: "t",
        envelopeTs: "ts",
        fleet: "fleet.yaml",
        taskId: "beefcafe",
      },
      ledger
    );

    await ackTask({ taskId: "beefcafe", worker: "W", fleet: "fleet.yaml" }, ledger);
    await blockTask({ taskId: "beefcafe", worker: "W", fleet: "fleet.yaml" }, ledger);
    assert.equal(state.records.get("beefcafe")?.status, "blocked");
  });

  test("merged task cannot be abandoned (terminal state)", async () => {
    const rec = makeRecord({ task_id: "12345678", PK: "TASK#12345678", status: "merged" });
    const { ledger } = makeMockLedger([rec]);
    await assert.rejects(
      () => abandonTask({ taskId: "12345678", fleet: "fleet.yaml" }, ledger),
      TaskConditionError
    );
  });
});
