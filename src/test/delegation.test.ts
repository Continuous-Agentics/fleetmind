/**
 * Unit tests for the delegation lib.
 *
 * These tests do NOT require a real DynamoDB connection.
 * They validate GSI key generation, S3 key rendering, task record shape,
 * and the JSON structure of PutItem inputs.
 *
 * Integration tests (real DDB/S3) are out of scope for Phase 1.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  gsi1pk,
  gsi2pk,
  taskPK,
  renderS3Key,
  DEFAULT_S3_KEY_TEMPLATE,
  TaskRecordSchema,
} from "../runtime/delegation/types.js";
import { TaskConditionError } from "../runtime/delegation/ddb.js";
import {
  buildShipNarrative,
  buildBlockNarrative,
} from "../runtime/delegation/s3.js";

// ── GSI key helpers ───────────────────────────────────────────────────────────

describe("gsi1pk", () => {
  test("builds project+status composite key", () => {
    assert.equal(
      gsi1pk("website-rewrite", "delegated"),
      "PROJECT#website-rewrite#STATUS#delegated"
    );
    assert.equal(
      gsi1pk("my-fleet", "merged"),
      "PROJECT#my-fleet#STATUS#merged"
    );
  });
});

describe("gsi2pk", () => {
  test("builds status namespaced key", () => {
    assert.equal(gsi2pk("delegated"), "STATUS#delegated");
    assert.equal(gsi2pk("shipped"), "STATUS#shipped");
  });
});

describe("taskPK", () => {
  test("prefixes TASK#", () => {
    assert.equal(taskPK("a1b2c3d4"), "TASK#a1b2c3d4");
  });
});

// ── S3 key rendering ──────────────────────────────────────────────────────────

describe("renderS3Key", () => {
  test("fills in all tokens", () => {
    const key = renderS3Key(DEFAULT_S3_KEY_TEMPLATE, {
      project: "website-rewrite",
      date: "2026-05-08",
      task_id: "a1b2c3d4",
    });
    assert.equal(
      key,
      "v0/projects/website-rewrite/tasks/2026-05-08-a1b2c3d4.md"
    );
  });

  test("works with a custom template", () => {
    const key = renderS3Key("tasks/{project}/{task_id}.md", {
      project: "my-proj",
      date: "2026-01-01",
      task_id: "deadbeef",
    });
    assert.equal(key, "tasks/my-proj/deadbeef.md");
  });
});

// ── TaskRecord schema validation ──────────────────────────────────────────────

describe("TaskRecordSchema", () => {
  test("accepts a valid task record", () => {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const record = {
      PK: "TASK#a1b2c3d4",
      task_id: "a1b2c3d4",
      v: "0.2",
      project: "website-rewrite",
      status: "delegated",
      GSI1PK: "PROJECT#website-rewrite#STATUS#delegated",
      GSI2PK: "STATUS#delegated",
      delegated_by: "U_PM_BOT",
      worker: "U_WORKER",
      delegated_at: now,
      lifecycle: "requires-human-signoff",
      definition_of_done: "The widget renders.",
      delegation_thread: "https://example.com/thread",
      delegation_envelope_ts: "1234567890.000000",
      tracker_link: null,
      task_s3_key: "v0/projects/website-rewrite/tasks/2026-05-08-a1b2c3d4.md",
      expires_at: Math.floor(Date.now() / 1000) + 365 * 86400,
    };
    const parsed = TaskRecordSchema.parse(record);
    assert.equal(parsed.task_id, "a1b2c3d4");
    assert.equal(parsed.status, "delegated");
  });

  test("rejects task_id that is not 8-char hex", () => {
    assert.throws(() => {
      TaskRecordSchema.parse({
        PK: "TASK#xyz",
        task_id: "xyz", // invalid
        v: "0.2",
        project: "p",
        status: "delegated",
        GSI1PK: "PROJECT#p#STATUS#delegated",
        GSI2PK: "STATUS#delegated",
        delegated_by: "U1",
        worker: "U2",
        delegated_at: new Date().toISOString(),
        lifecycle: "requires-human-signoff",
        definition_of_done: "done",
        delegation_thread: "https://x",
        delegation_envelope_ts: "ts",
        task_s3_key: "v0/key.md",
        expires_at: 0,
      });
    });
  });

  test("rejects an invalid status value", () => {
    assert.throws(() => {
      TaskRecordSchema.shape.status.parse("in-progress");
    });
  });
});

// ── TaskConditionError ────────────────────────────────────────────────────────

describe("TaskConditionError", () => {
  test("is an Error subclass", () => {
    const err = new TaskConditionError("test");
    assert.ok(err instanceof Error);
    assert.equal(err.name, "TaskConditionError");
    assert.equal(err.message, "test");
  });
});

// ── Narrative builders ────────────────────────────────────────────────────────

describe("buildShipNarrative", () => {
  test("produces valid markdown with frontmatter", () => {
    const md = buildShipNarrative({
      taskId: "a1b2c3d4",
      taskDescription: "Add a date filter.",
      whatIDid: "Implemented the filter component.",
      whatIDidntDo: "Did not add tests.",
      links: ["PR: https://github.com/org/repo/pull/1"],
      learned: ["Zod type inference is great for runtime validation."],
    });
    assert.ok(md.startsWith("---\nv: 0.2\ntask_id: a1b2c3d4"));
    assert.ok(md.includes("## Task"));
    assert.ok(md.includes("## What I did"));
    assert.ok(md.includes("## Learned"));
    assert.ok(md.includes("Zod type inference"));
  });
});

describe("buildBlockNarrative", () => {
  test("produces valid markdown with Need section", () => {
    const md = buildBlockNarrative({
      taskId: "deadbeef",
      taskDescription: "Migrate the schema.",
      whatITried: "Tried running the migration.",
      need: "Need the DB password in Secrets Manager.",
    });
    assert.ok(md.startsWith("---\nv: 0.2\ntask_id: deadbeef"));
    assert.ok(md.includes("## Need"));
    assert.ok(md.includes("Need the DB password"));
  });
});
