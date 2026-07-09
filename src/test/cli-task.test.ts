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
  updateTask,
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
      // Mirror the lifecycle-gated DDB condition:
      // (status = shipped AND lifecycle = shipped-is-done) OR status = signed_off
      const shippedIsDone = record?.status === "shipped" && record?.lifecycle === "shipped-is-done";
      const signedOff = record?.status === "signed_off";
      if (!record || (!shippedIsDone && !signedOff)) {
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

    async updateTaskMetadata(taskId, updates, options) {
      state.calls.push({ method: "updateTaskMetadata", args: [taskId, updates, options] });
      const record = state.records.get(taskId);
      if (!record) {
        throw new TaskConditionError(`Task not found: ${taskId}. Cannot update metadata of a non-existent task.`);
      }
      if (record.status === "merged" || record.status === "abandoned") {
        throw new TaskConditionError(
          `Task ${taskId} is in terminal status '${record.status}'. Terminal tasks are frozen — metadata cannot be updated.`
        );
      }
      const now = NOW;
      const by = options?.by ?? "test-agent";
      const updated: TaskRecord = { ...record, updated_at: now, updated_by: by };

      if (updates.title !== undefined) updated.title = updates.title as string;
      if (updates.description !== undefined) updated.description = updates.description as string;
      if (updates.definition_of_done !== undefined) updated.definition_of_done = updates.definition_of_done;
      if (updates.worker_id !== undefined) updated.worker = updates.worker_id;
      if (updates.thread_url !== undefined) updated.delegation_thread = updates.thread_url;
      if (updates.envelope_ts !== undefined) updated.delegation_envelope_ts = updates.envelope_ts;
      if (updates.project !== undefined) {
        updated.project = updates.project;
        updated.GSI1PK = gsi1pk(updates.project, record.status);
      }

      if (options?.reason !== undefined) {
        const entry = { at: now, by, reason: options.reason, fields_changed: Object.keys(updates) };
        const existing = updated.update_history ?? [];
        updated.update_history = [...existing, entry].slice(-20);
      }

      state.records.set(taskId, updated);
      return updated;
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
  // MF-1 fix: shipped-is-done tasks may merge from shipped directly
  test("success — shipped→merged (lifecycle: shipped-is-done)", async () => {
    const rec = makeRecord({ status: "shipped", lifecycle: "shipped-is-done" });
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

  // MF-1 regression tests — lifecycle gate on merge
  test("MF-1 regression: shipped + requires-human-signoff → merge MUST fail (bypass blocked)", async () => {
    // Before MF-1 fix, this would silently succeed, letting the human sign-off
    // be skipped entirely. Now the lifecycle gate rejects it.
    const rec = makeRecord({ status: "shipped", lifecycle: "requires-human-signoff" });
    const { ledger } = makeMockLedger([rec]);
    await assert.rejects(
      () => mergeTask({ taskId: "a1b2c3d4", fleet: "fleet.yaml" }, ledger),
      TaskConditionError
    );
  });

  test("MF-1 regression: shipped + shipped-is-done → merge succeeds (no sign-off required)", async () => {
    const rec = makeRecord({ status: "shipped", lifecycle: "shipped-is-done" });
    const { ledger, state } = makeMockLedger([rec]);
    await mergeTask({ taskId: "a1b2c3d4", fleet: "fleet.yaml" }, ledger);
    assert.equal(state.records.get("a1b2c3d4")?.status, "merged");
  });

  test("MF-1 regression: signed_off (requires-human-signoff path) → merge succeeds", async () => {
    // After a requires-human-signoff task passes through signoff, merging from
    // signed_off is always permitted regardless of lifecycle.
    const rec = makeRecord({ status: "signed_off", lifecycle: "requires-human-signoff" });
    const { ledger, state } = makeMockLedger([rec]);
    await mergeTask({ taskId: "a1b2c3d4", fleet: "fleet.yaml" }, ledger);
    assert.equal(state.records.get("a1b2c3d4")?.status, "merged");
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

// ── Tests: updateTask ─────────────────────────────────────────────────────────

describe("updateTask", () => {
  test("single field update (--title only) — only that field + updated_at/updated_by changed", async () => {
    const rec = makeRecord({ status: "accepted" });
    const { ledger, state } = makeMockLedger([rec]);
    const result = await updateTask(
      { taskId: "a1b2c3d4", title: "New Title", fleet: "fleet.yaml" },
      ledger
    );
    assert.equal(result.title, "New Title");
    assert.ok(result.updated_at, "updated_at should be set");
    assert.ok(result.updated_by, "updated_by should be set");
    // Other fields unchanged
    assert.equal(result.status, "accepted");
    assert.equal(result.project, "website-rewrite");
    assert.equal(state.calls.at(-1)?.method, "updateTaskMetadata");
  });

  test("multiple fields at once — all updated", async () => {
    const rec = makeRecord({ status: "delegated" });
    const { ledger } = makeMockLedger([rec]);
    const result = await updateTask(
      {
        taskId: "a1b2c3d4",
        title: "Revised Title",
        dod: "New definition of done",
        worker: "U_NEW_WORKER",
        fleet: "fleet.yaml",
      },
      ledger
    );
    assert.equal(result.title, "Revised Title");
    assert.equal(result.definition_of_done, "New definition of done");
    assert.equal(result.worker, "U_NEW_WORKER");
  });

  test("no field flags → exit 1 with clear error (process.exit spy)", async () => {
    // We test this by checking the exported function returns an error path via
    // process.exit, which we catch by wrapping in a try-catch on the exit mock.
    const rec = makeRecord({ status: "accepted" });
    const { ledger } = makeMockLedger([rec]);

    const originalExit = process.exit.bind(process);
    let exitCode: number | undefined;
    // Temporarily override process.exit to capture code without actually exiting
    (process as NodeJS.Process).exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never;

    try {
      await updateTask({ taskId: "a1b2c3d4", fleet: "fleet.yaml" }, ledger);
      assert.fail("Should have exited");
    } catch (err: unknown) {
      assert.ok((err as Error).message.includes("process.exit(1)"), `Expected exit(1), got: ${(err as Error).message}`);
      assert.equal(exitCode, 1);
    } finally {
      (process as NodeJS.Process).exit = originalExit as never;
    }
  });

  test("update merged task → exit 2 TaskConditionError", async () => {
    const rec = makeRecord({ status: "merged" });
    const { ledger } = makeMockLedger([rec]);
    await assert.rejects(
      () => updateTask({ taskId: "a1b2c3d4", title: "No", fleet: "fleet.yaml" }, ledger),
      TaskConditionError
    );
  });

  test("update abandoned task → TaskConditionError", async () => {
    const rec = makeRecord({ status: "abandoned" });
    const { ledger } = makeMockLedger([rec]);
    await assert.rejects(
      () => updateTask({ taskId: "a1b2c3d4", dod: "No", fleet: "fleet.yaml" }, ledger),
      TaskConditionError
    );
  });

  test("--project change updates GSI1PK with current status", async () => {
    const rec = makeRecord({
      status: "accepted",
      GSI1PK: gsi1pk("website-rewrite", "accepted"),
      GSI2PK: gsi2pk("accepted"),
    });
    const { ledger, state } = makeMockLedger([rec]);
    await updateTask(
      { taskId: "a1b2c3d4", project: "new-project", fleet: "fleet.yaml" },
      ledger
    );
    const updated = state.records.get("a1b2c3d4")!;
    assert.equal(updated.project, "new-project");
    assert.equal(updated.GSI1PK, gsi1pk("new-project", "accepted"));
    // GSI2PK (status-only index) is untouched by a project rename
    assert.equal(updated.GSI2PK, gsi2pk("accepted"));
  });

  test("--reason appends to update_history", async () => {
    const rec = makeRecord({ status: "delegated" });
    const { ledger, state } = makeMockLedger([rec]);
    await updateTask(
      { taskId: "a1b2c3d4", dod: "Narrowed scope", reason: "PM cut scope after worker review", fleet: "fleet.yaml" },
      ledger
    );
    const updated = state.records.get("a1b2c3d4")!;
    assert.ok(Array.isArray(updated.update_history), "update_history should be an array");
    assert.equal(updated.update_history!.length, 1);
    assert.equal(updated.update_history![0]!.reason, "PM cut scope after worker review");
    assert.ok(updated.update_history![0]!.fields_changed.includes("definition_of_done"));
  });

  test("--by overrides env-derived updated_by", async () => {
    const rec = makeRecord({ status: "accepted" });
    const { ledger, state } = makeMockLedger([rec]);
    await updateTask(
      { taskId: "a1b2c3d4", title: "Override test", by: "explicit-bot-id", fleet: "fleet.yaml" },
      ledger
    );
    const updated = state.records.get("a1b2c3d4")!;
    assert.equal(updated.updated_by, "explicit-bot-id");
  });

  test("--description-file reads from file", async () => {
    const rec = makeRecord({ status: "delegated" });
    const { ledger, state } = makeMockLedger([rec]);

    // Write a temp file
    const { writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpFile = join(tmpdir(), `fleetmind-test-${Date.now()}.txt`);
    writeFileSync(tmpFile, "Description from file\n");

    await updateTask(
      { taskId: "a1b2c3d4", descriptionFile: tmpFile, fleet: "fleet.yaml" },
      ledger
    );
    const updated = state.records.get("a1b2c3d4")!;
    assert.equal(updated.description, "Description from file");
  });

  test("--json output shape — result includes task_id, status, updated_at", async () => {
    const rec = makeRecord({ status: "delegated" });
    const { ledger } = makeMockLedger([rec]);
    const result = await updateTask(
      { taskId: "a1b2c3d4", title: "JSON test", json: true, fleet: "fleet.yaml" },
      ledger
    );
    assert.ok("task_id" in result);
    assert.ok("status" in result);
    assert.ok("updated_at" in result);
  });

  test("update_history bounded to 20 entries — older entries dropped", async () => {
    // Simulate a record with 20 existing history entries
    const existingHistory = Array.from({ length: 20 }, (_, i) => ({
      at: NOW,
      by: "bot",
      reason: `change ${i}`,
      fields_changed: ["title"],
    }));
    const rec = makeRecord({ status: "accepted", update_history: existingHistory });
    const { ledger, state } = makeMockLedger([rec]);
    await updateTask(
      { taskId: "a1b2c3d4", title: "21st update", reason: "one more", fleet: "fleet.yaml" },
      ledger
    );
    const updated = state.records.get("a1b2c3d4")!;
    assert.ok(updated.update_history!.length <= 20, "history should be bounded to 20");
    // Last entry should be the most recent
    assert.equal(updated.update_history!.at(-1)!.reason, "one more");
  });
});
