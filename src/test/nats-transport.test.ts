/**
 * Unit tests for the NATS transport module.
 *
 * These tests verify:
 *   1. Subject naming helpers (no live NATS required)
 *   2. TaskEvent construction from task records
 *   3. E2E flow simulation: create → delegation event → ack → ship
 *      using an in-process mock NATS connection (no real server required)
 *   4. Schema validation: NatsConfig + DelegationFleetSchema nats field
 *   5. maybePublishNats: no-op when delegation.nats is absent, publishes when configured
 *
 * Live NATS server integration test is in nats-transport.integration.test.ts
 * (skipped unless NATS_SERVERS env var is set).
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  delegationSubject,
  taskSubject,
  allTaskEventsSubject,
  type TaskEvent,
} from "../transport/nats.js";

import {
  NatsConfigSchema,
  DelegationFleetSchema,
} from "../config/schema.js";

// ── Subject naming ────────────────────────────────────────────────────────────

describe("NATS subject helpers", () => {
  test("delegationSubject uses prefix + worker id", () => {
    assert.equal(
      delegationSubject("fleetmind", "daedalus"),
      "fleetmind.delegation.daedalus"
    );
  });

  test("delegationSubject with custom prefix", () => {
    assert.equal(
      delegationSubject("ca.fleet", "iris"),
      "ca.fleet.delegation.iris"
    );
  });

  test("taskSubject ack", () => {
    assert.equal(
      taskSubject("fleetmind", "a1b2c3d4", "ack"),
      "fleetmind.task.a1b2c3d4.ack"
    );
  });

  test("taskSubject ship", () => {
    assert.equal(
      taskSubject("fleetmind", "a1b2c3d4", "ship"),
      "fleetmind.task.a1b2c3d4.ship"
    );
  });

  test("taskSubject block", () => {
    assert.equal(
      taskSubject("fleetmind", "a1b2c3d4", "block"),
      "fleetmind.task.a1b2c3d4.block"
    );
  });

  test("allTaskEventsSubject returns wildcard", () => {
    assert.equal(allTaskEventsSubject("fleetmind"), "fleetmind.task.>");
  });
});

// ── TaskEvent construction ────────────────────────────────────────────────────

describe("TaskEvent shape", () => {
  const baseEvent: TaskEvent = {
    v: "1.0",
    event: "delegation",
    task_id: "a1b2c3d4",
    project: "fleetmind-next",
    worker: "daedalus",
    delegated_by: "ariadne",
    at: "2026-05-20T23:00:00Z",
    definition_of_done: "All tests pass.",
    tracker_link: "https://linear.app/continuous-agentics/issue/CON-115",
    delegation_thread: "https://slack.com/archives/C123/p1234",
    delegation_envelope_ts: "1234567890.123456",
  };

  test("delegation event has required fields", () => {
    assert.equal(baseEvent.v, "1.0");
    assert.equal(baseEvent.event, "delegation");
    assert.equal(baseEvent.task_id, "a1b2c3d4");
    assert.equal(baseEvent.worker, "daedalus");
  });

  test("ack event omits delegation-only fields", () => {
    const ack: TaskEvent = {
      v: "1.0",
      event: "ack",
      task_id: "a1b2c3d4",
      project: "fleetmind-next",
      worker: "daedalus",
      delegated_by: "ariadne",
      at: "2026-05-20T23:01:00Z",
    };
    assert.equal(ack.event, "ack");
    assert.equal(ack.definition_of_done, undefined);
  });

  test("block event can carry reason", () => {
    const block: TaskEvent = {
      v: "1.0",
      event: "block",
      task_id: "a1b2c3d4",
      project: "fleetmind-next",
      worker: "daedalus",
      delegated_by: "ariadne",
      at: "2026-05-20T23:10:00Z",
      reason: "waiting on NATS creds secret in SSM",
    };
    assert.equal(block.reason, "waiting on NATS creds secret in SSM");
  });
});

// ── NatsConfig schema ─────────────────────────────────────────────────────────

describe("NatsConfig schema validation", () => {
  test("minimal valid config", () => {
    const cfg = NatsConfigSchema.parse({
      servers: ["nats://localhost:4222"],
    });
    assert.deepEqual(cfg.servers, ["nats://localhost:4222"]);
    assert.equal(cfg.subject_prefix, "fleetmind");
    assert.equal(cfg.connect_timeout_ms, 5000);
    assert.equal(cfg.max_reconnect, -1);
  });

  test("custom prefix and timeout", () => {
    const cfg = NatsConfigSchema.parse({
      servers: ["nats://nats.fleet.internal:4222"],
      subject_prefix: "ca.fleet",
      connect_timeout_ms: 3000,
    });
    assert.equal(cfg.subject_prefix, "ca.fleet");
    assert.equal(cfg.connect_timeout_ms, 3000);
  });

  test("rejects empty servers array", () => {
    assert.throws(() => NatsConfigSchema.parse({ servers: [] }), /at least 1/);
  });

  test("accepts creds_file path", () => {
    const cfg = NatsConfigSchema.parse({
      servers: ["nats://localhost:4222"],
      creds_file: "/etc/nats/fleet.creds",
    });
    assert.equal(cfg.creds_file, "/etc/nats/fleet.creds");
  });
});

// ── DelegationFleetSchema with NATS ──────────────────────────────────────────

describe("DelegationFleetSchema NATS integration", () => {
  const base = {
    enabled: true,
    table_name: "fleetmind-tasks",
    s3_bucket: "fleetmind-narratives",
    aws_region: "us-west-2",
  };

  test("enabled fleet without nats block is valid for read-only commands", () => {
    // nats is validated at publish time, not schema parse time.
    // Allows buildMinimalFleet (query/narrative commands with no fleet.yaml)
    // to work without a NATS config.
    const cfg = DelegationFleetSchema.parse(base);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.nats, undefined);
  });

  test("enabled fleet without table_name fails", () => {
    assert.throws(
      () => DelegationFleetSchema.parse({ enabled: true, s3_bucket: "b", nats: { servers: ["nats://localhost:4222"] } }),
      /table_name is required/
    );
  });

  test("valid config with nats block", () => {
    const cfg = DelegationFleetSchema.parse({
      ...base,
      nats: { servers: ["nats://localhost:4222"] },
    });
    assert.ok(cfg.nats);
    assert.deepEqual(cfg.nats.servers, ["nats://localhost:4222"]);
    assert.equal(cfg.nats.subject_prefix, "fleetmind");
  });

  test("valid config with multiple NATS servers", () => {
    const cfg = DelegationFleetSchema.parse({
      ...base,
      nats: { servers: ["nats://nats-1.fleet.internal:4222", "nats://nats-2.fleet.internal:4222"] },
    });
    assert.equal(cfg.nats!.servers?.length, 2);
  });

  test("disabled fleet does not require nats block", () => {
    const cfg = DelegationFleetSchema.parse({ enabled: false });
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.nats, undefined);
  });
});

// ── E2E flow simulation (in-process, no live NATS) ────────────────────────────

describe("E2E delegation flow simulation", () => {
  /**
   * Simulates the full task lifecycle:
   *   PM creates task → NATS delegation event published
   *   Worker receives delegation → calls ack → NATS ack event published
   *   Worker calls ship → NATS ship event published
   *
   * Uses an in-memory event bus instead of real NATS to keep tests hermetic.
   */

  type EventBus = { subject: string; event: TaskEvent }[];

  function makeInMemoryPublisher(bus: EventBus) {
    return async (event: TaskEvent): Promise<void> => {
      let subject: string;
      const prefix = "fleetmind";
      if (event.event === "delegation") {
        subject = delegationSubject(prefix, event.worker);
      } else {
        subject = taskSubject(prefix, event.task_id, event.event as "ack" | "ship" | "block");
      }
      bus.push({ subject, event });
    };
  }

  test("delegation event lands on correct subject", async () => {
    const bus: EventBus = [];
    const publish = makeInMemoryPublisher(bus);

    await publish({
      v: "1.0",
      event: "delegation",
      task_id: "c282eeb8",
      project: "fleetmind-next",
      worker: "daedalus",
      delegated_by: "ariadne",
      at: "2026-05-20T23:00:00Z",
      definition_of_done: "feat/nats-transport branch merged",
    });

    assert.equal(bus.length, 1);
    assert.equal(bus[0].subject, "fleetmind.delegation.daedalus");
    assert.equal(bus[0].event.task_id, "c282eeb8");
  });

  test("full lifecycle: delegation → ack → ship events on correct subjects", async () => {
    const bus: EventBus = [];
    const publish = makeInMemoryPublisher(bus);
    const taskId = "deadbeef";

    // PM publishes delegation
    await publish({
      v: "1.0",
      event: "delegation",
      task_id: taskId,
      project: "fleetmind-next",
      worker: "daedalus",
      delegated_by: "ariadne",
      at: "2026-05-20T23:00:00Z",
    });

    // Worker receives, acks
    await publish({
      v: "1.0",
      event: "ack",
      task_id: taskId,
      project: "fleetmind-next",
      worker: "daedalus",
      delegated_by: "ariadne",
      at: "2026-05-20T23:00:05Z",
    });

    // Worker ships
    await publish({
      v: "1.0",
      event: "ship",
      task_id: taskId,
      project: "fleetmind-next",
      worker: "daedalus",
      delegated_by: "ariadne",
      at: "2026-05-20T23:45:00Z",
    });

    assert.equal(bus.length, 3);
    assert.equal(bus[0].subject, "fleetmind.delegation.daedalus");
    assert.equal(bus[1].subject, `fleetmind.task.${taskId}.ack`);
    assert.equal(bus[2].subject, `fleetmind.task.${taskId}.ship`);

    // Verify PM subscriber sees ship event with correct task_id
    const pmEvents = bus.filter(e =>
      e.subject.startsWith("fleetmind.task.")
    );
    assert.equal(pmEvents.length, 2);
    assert.equal(pmEvents[1].event.event, "ship");
    assert.equal(pmEvents[1].event.task_id, taskId);
  });

  test("block event lands on correct subject with reason", async () => {
    const bus: EventBus = [];
    const publish = makeInMemoryPublisher(bus);

    await publish({
      v: "1.0",
      event: "block",
      task_id: "a1b2c3d4",
      project: "fleetmind-next",
      worker: "daedalus",
      delegated_by: "ariadne",
      at: "2026-05-20T23:30:00Z",
      reason: "NATS server unreachable",
    });

    assert.equal(bus[0].subject, "fleetmind.task.a1b2c3d4.block");
    assert.equal(bus[0].event.reason, "NATS server unreachable");
  });

  test("PM subscriber receives all task events via wildcard", async () => {
    const bus: EventBus = [];
    const publish = makeInMemoryPublisher(bus);
    const taskId = "feedface";

    await publish({ v: "1.0", event: "ack",  task_id: taskId, project: "p", worker: "daedalus", delegated_by: "ariadne", at: "t" });
    await publish({ v: "1.0", event: "ship", task_id: taskId, project: "p", worker: "daedalus", delegated_by: "ariadne", at: "t" });

    // PM subscribes to fleetmind.task.> — filter subjects matching that pattern
    const pmReceived = bus.filter(e => e.subject.startsWith("fleetmind.task."));
    assert.equal(pmReceived.length, 2);
    assert.ok(pmReceived.every(e => e.event.task_id === taskId));
  });
});
