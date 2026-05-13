/**
 * Unit tests for WORKER_SWEEP cron seeding.
 *
 * Tests cover:
 *   - CronSweepSchema validation (requires every OR cron_expr)
 *   - DelegationAgentSchema accepts sweeps[]
 *   - sweepJobId is deterministic and produces UUID-shaped strings
 *   - seedCronSweeps writes new jobs, skips existing names, is PM-bot-only
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, describe, beforeEach, afterEach } from "node:test";

import { CronSweepSchema, DelegationAgentSchema } from "../config/schema.js";

// ── CronSweepSchema ───────────────────────────────────────────────────────────

describe("CronSweepSchema", () => {
  test("accepts every-based sweep", () => {
    const s = CronSweepSchema.parse({
      name: "conductor-sweep-pixel",
      worker_id: "pixel",
      every: "5m",
    });
    assert.equal(s.name, "conductor-sweep-pixel");
    assert.equal(s.worker_id, "pixel");
    assert.equal(s.every, "5m");
    assert.equal(s.model, "haiku"); // default
  });

  test("accepts cron_expr-based sweep with tz", () => {
    const s = CronSweepSchema.parse({
      name: "sweep-forge-business-hours",
      worker_id: "forge",
      cron_expr: "*/5 9-17 * * 1-5",
      tz: "America/Los_Angeles",
      model: "sonnet",
    });
    assert.equal(s.cron_expr, "*/5 9-17 * * 1-5");
    assert.equal(s.tz, "America/Los_Angeles");
    assert.equal(s.model, "sonnet");
  });

  test("rejects sweep with neither every nor cron_expr", () => {
    assert.throws(
      () => CronSweepSchema.parse({ name: "bad", worker_id: "w" }),
      /must specify either/
    );
  });

  test("accepts optional description", () => {
    const s = CronSweepSchema.parse({
      name: "s",
      worker_id: "w",
      every: "10m",
      description: "Poll worker tasks",
    });
    assert.equal(s.description, "Poll worker tasks");
  });
});

// ── DelegationAgentSchema accepts sweeps ──────────────────────────────────────

describe("DelegationAgentSchema.sweeps", () => {
  test("accepts an agent delegation block with sweeps", () => {
    const d = DelegationAgentSchema.parse({
      worker_bots: ["pixel", "forge"],
      sweeps: [
        { name: "sweep-pixel", worker_id: "pixel", every: "5m" },
        { name: "sweep-forge", worker_id: "forge", every: "5m" },
      ],
    });
    assert.equal(d.sweeps?.length, 2);
    assert.equal(d.sweeps?.[0]?.worker_id, "pixel");
  });

  test("allows missing sweeps (worker bots)", () => {
    const d = DelegationAgentSchema.parse({ specialty: "backend" });
    assert.equal(d.sweeps, undefined);
  });
});

// ── sweepJobId determinism ────────────────────────────────────────────────────

/**
 * Re-implement sweepJobId locally so this test doesn't depend on provisioner
 * internals — it only verifies the deterministic contract.
 */
function sweepJobId(fleetName: string, agentId: string, sweepName: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(`fleetmind:sweep:${fleetName}:${agentId}:${sweepName}`)
    .digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${((parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16)}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

describe("sweepJobId", () => {
  test("is deterministic for the same inputs", () => {
    const a = sweepJobId("acme-fleet", "conductor", "sweep-pixel");
    const b = sweepJobId("acme-fleet", "conductor", "sweep-pixel");
    assert.equal(a, b);
  });

  test("differs for different fleet names", () => {
    const a = sweepJobId("fleet-a", "conductor", "sweep-pixel");
    const b = sweepJobId("fleet-b", "conductor", "sweep-pixel");
    assert.notEqual(a, b);
  });

  test("differs for different sweep names", () => {
    const a = sweepJobId("fleet", "conductor", "sweep-pixel");
    const b = sweepJobId("fleet", "conductor", "sweep-forge");
    assert.notEqual(a, b);
  });

  test("produces UUID-shaped string (8-4-4-4-12)", () => {
    const id = sweepJobId("fleet", "conductor", "sweep-pixel");
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

// ── seedCronSweeps integration (filesystem) ───────────────────────────────────

// Import provisioner after schema so module cache is warm.
import { provisionAgent } from "../runtime/provisioner.js";
import type { Fleet, AgentConfig } from "../config/schema.js";

/** Minimal Fleet fixture for seeding tests. */
function makeFleet(workspaceBase: string): Fleet {
  return {
    fleet: { name: "test-fleet", version: "1.0.0", client: "", description: "" },
    agents: {
      defaults: {
        model: "anthropic/claude-sonnet-4-6",
        workspace_base: workspaceBase,
        plugins: ["anthropic"],
      },
      list: [],
    },
    skills_repo: { url: "", branch: "main", poll_interval: "60s" },
    private_registry: {
      url: "https://npm.pkg.github.com",
      token_env: "CA_REGISTRY_TOKEN",
      scope: "@continuous-agentics",
    },
    secrets: { provider: "env" },
    outputs: {
      openclaw_json: "./rendered/openclaw.json",
      terraform_vars: "./rendered/fleet.derived.tfvars",
      workspace_manifests: "./rendered/workspaces/",
    },
    openclaw: {
      gateway: { port: 18789, mode: "local", bind: "loopback" },
      session: { dm_scope: "per-channel-peer" },
      tools: { profile: "coding", web_search: { enabled: true, provider: "brave" } },
      slack: {
        mode: "socket", typing_reaction: "thinking_face", ack_reaction: "eyes",
        allow_bots: true, history_limit: 111,
        streaming: { mode: "partial", native_transport: true },
        reply_to_mode_by_chat_type: { channel: "all" },
      },
    },
    context: { provider: "local" },
    delegation: undefined,
    getAgent: (_id: string) => undefined,
    orchestrator: undefined,
    specialists: [],
  } as unknown as Fleet;
}

function makePmAgent(sweeps: object[]): AgentConfig {
  return {
    id: "conductor",
    name: "Conductor",
    emoji: "🎼",
    description: "PM bot",
    orchestrator: true,
    persona: { soul: "You are Conductor." },
    slack: {
      account_id: "conductor",
      bot_token: "xoxb-test",
      app_token: "xapp-test",
    },
    skills: [],
    plugins: ["anthropic"],
    agent_to_agent: { can_send_to: [] },
    delegation: {
      worker_bots: ["pixel"],
      sweeps: sweeps as AgentConfig["delegation"] extends { sweeps?: infer S } ? S : never,
    },
  } as unknown as AgentConfig;
}

describe("seedCronSweeps (filesystem)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetmind-sweep-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates jobs.json with seeded sweep", async () => {
    const fleet = makeFleet(tmpDir);
    const agent = makePmAgent([
      { name: "sweep-pixel", worker_id: "pixel", every: "5m" },
    ]);

    // Pass tmpDir as localBase so output goes to tmpDir/rendered/cron/jobs.json
    await provisionAgent(fleet, agent, false, tmpDir);

    const jobsPath = path.join(tmpDir, "rendered", "cron", "jobs.json");
    assert.ok(fs.existsSync(jobsPath), "jobs.json should be created");

    const f = JSON.parse(fs.readFileSync(jobsPath, "utf-8"));
    assert.equal(f.version, 1);
    const job = f.jobs.find((j: { name: string }) => j.name === "sweep-pixel");
    assert.ok(job, "sweep-pixel job should be present");
    assert.equal(job.payload.message, "WORKER_SWEEP: pixel");
    assert.equal(job.payload.model, "haiku");
    assert.equal(job.sessionTarget, "isolated");
    assert.equal(job.delivery.mode, "none");
    assert.deepEqual(job.schedule, { kind: "every", every: "5m" });
  });

  test("preserves existing jobs and only appends new ones", async () => {
    const cronDir = path.join(tmpDir, "rendered", "cron");
    fs.mkdirSync(cronDir, { recursive: true });
    const existingJob = {
      id: "existing-id",
      name: "sweep-pixel",
      enabled: true,
      createdAtMs: 1000,
      schedule: { kind: "every", every: "10m" }, // intentionally different
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "WORKER_SWEEP: pixel", model: "haiku" },
      delivery: { mode: "none" },
      state: {},
    };
    fs.writeFileSync(
      path.join(cronDir, "jobs.json"),
      JSON.stringify({ version: 1, jobs: [existingJob] }, null, 2)
    );

    const fleet = makeFleet(tmpDir);
    const agent = makePmAgent([
      { name: "sweep-pixel", worker_id: "pixel", every: "5m" }, // already exists
      { name: "sweep-forge", worker_id: "forge", every: "5m" }, // new
    ]);

    await provisionAgent(fleet, agent, false, tmpDir);

    const f = JSON.parse(fs.readFileSync(path.join(cronDir, "jobs.json"), "utf-8"));
    assert.equal(f.jobs.length, 2, "should have original + new job");
    // Original job preserved (schedule not overwritten)
    const pixel = f.jobs.find((j: { name: string }) => j.name === "sweep-pixel");
    assert.deepEqual(pixel.schedule, { kind: "every", every: "10m" }, "existing schedule preserved");
    // New job added
    const forge = f.jobs.find((j: { name: string }) => j.name === "sweep-forge");
    assert.ok(forge, "sweep-forge should be added");
    assert.equal(forge.payload.message, "WORKER_SWEEP: forge");
  });

  test("dry-run does not write jobs.json", async () => {
    const fleet = makeFleet(tmpDir);
    const agent = makePmAgent([
      { name: "sweep-pixel", worker_id: "pixel", every: "5m" },
    ]);

    await provisionAgent(fleet, agent, true /* dryRun */, tmpDir);

    const jobsPath = path.join(tmpDir, "rendered", "cron", "jobs.json");
    assert.ok(!fs.existsSync(jobsPath), "jobs.json should NOT be created on dry run");
  });

  test("worker bot (orchestrator=false) does not get sweeps seeded", async () => {
    const fleet = makeFleet(tmpDir);
    const workerAgent: AgentConfig = {
      ...makePmAgent([{ name: "sweep-pixel", worker_id: "pixel", every: "5m" }]),
      orchestrator: false,
    } as unknown as AgentConfig;

    await provisionAgent(fleet, workerAgent, false, tmpDir);

    const jobsPath = path.join(tmpDir, "rendered", "cron", "jobs.json");
    assert.ok(!fs.existsSync(jobsPath), "worker bot should not get cron seeding");
  });

  test("seeded job ID is stable across re-deploys", async () => {
    const fleet = makeFleet(tmpDir);
    const agent = makePmAgent([
      { name: "sweep-pixel", worker_id: "pixel", every: "5m" },
    ]);

    // First deploy
    await provisionAgent(fleet, agent, false, tmpDir);
    const first = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "rendered", "cron", "jobs.json"), "utf-8")
    );
    const firstId = first.jobs[0].id;

    // Wipe the rendered dir and re-deploy (simulates a fresh instance)
    fs.rmSync(path.join(tmpDir, "rendered", "cron"), { recursive: true, force: true });
    await provisionAgent(fleet, agent, false, tmpDir);
    const second = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "rendered", "cron", "jobs.json"), "utf-8")
    );
    const secondId = second.jobs[0].id;

    assert.equal(firstId, secondId, "job ID must be stable across re-deploys");
  });
});
