/**
 * Regression tests for the fleetmind deploy local-render-path bugs.
 *
 * Bug 1: Provisioner used workspace_base (EC2-side absolute path) as the local
 *   mkdir target, causing EACCES on macOS/non-root machines:
 *     EACCES: permission denied, mkdir '/opt/openclaw/workspace/workspace-conductor'
 *
 * Bug 2: Per-agent dir had spurious "workspace-" prefix ("workspace-conductor")
 *   that didn't match the EC2-side Terraform output ("conductor").
 *
 * These tests verify:
 *   1. Local render writes to <localBase>/rendered/workspaces/<agent_id>/ — never
 *      to an absolute path from workspace_base.
 *   2. No "workspace-" prefix anywhere in local output.
 *   3. workspace_base from fleet.yaml is preserved in the rendered openclaw.json
 *      (for the agent gateway to use on EC2).
 *   4. deploy does not try to mkdir an absolute path on the operator's machine.
 *   5. Cron sweeps write to <localBase>/rendered/cron/ (not to workspace_base/cron/).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, describe, beforeEach, afterEach } from "node:test";

import { provisionAgent, provisionFleet } from "../runtime/provisioner.js";
import { renderOpenClawJson } from "../runtime/renderer.js";
import type { Fleet, AgentConfig } from "../config/schema.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const EC2_WORKSPACE_BASE = "/opt/openclaw/workspace";

/** Minimal Fleet with an EC2-style workspace_base (absolute path). */
function makeFleet(workspaceBase = EC2_WORKSPACE_BASE): Fleet {
  return {
    fleet: { name: "gg-sandbox", version: "1.0.0", client: "carpe", description: "" },
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
      terraform_vars: "./rendered/fleet.auto.tfvars",
      workspace_manifests: "./rendered/workspaces/",
    },
    openclaw: {
      gateway: { port: 18789, mode: "local", bind: "loopback" },
      session: { dm_scope: "per-channel-peer" },
      tools: { profile: "coding", web_search: { enabled: false, provider: "brave" } },
      slack: {
        mode: "socket", typing_reaction: "thinking_face", ack_reaction: "eyes",
        allow_bots: true, history_limit: 50,
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

function makeConductorAgent(): AgentConfig {
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
    agent_to_agent: { can_send_to: ["forge"] },
    delegation: {
      worker_bots: ["forge"],
      sweeps: [{ name: "sweep-forge", worker_id: "forge", every: "5m", model: "haiku" }],
    },
  } as unknown as AgentConfig;
}

function makeForgeAgent(): AgentConfig {
  return {
    id: "forge",
    name: "Forge",
    emoji: "⚙️",
    description: "Worker bot",
    orchestrator: false,
    persona: { soul: "You are Forge." },
    slack: {
      account_id: "forge",
      bot_token: "xoxb-forge-test",
      app_token: "xapp-forge-test",
    },
    skills: [],
    plugins: ["anthropic"],
    agent_to_agent: { can_send_to: ["conductor"] },
    delegation: { specialty: "backend" },
  } as unknown as AgentConfig;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("deploy local-render-path regression", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetmind-deploy-path-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Bug 1: no absolute workspace_base path used locally ───────────────────

  test("provisionAgent writes to localBase/rendered/workspaces/<id>/, not to workspace_base", async () => {
    const fleet = makeFleet(); // workspace_base = /opt/openclaw/workspace
    const agent = makeConductorAgent();

    await provisionAgent(fleet, agent, false, tmpDir);

    const expectedWorkspace = path.join(tmpDir, "rendered", "workspaces", "conductor");
    assert.ok(fs.existsSync(expectedWorkspace), `workspace dir should exist at ${expectedWorkspace}`);

    // The absolute EC2-side dir must NOT exist on this machine.
    assert.ok(
      !fs.existsSync(EC2_WORKSPACE_BASE),
      `workspace_base ${EC2_WORKSPACE_BASE} must NOT be created locally`
    );
  });

  test("provisionAgent does not try to mkdir an absolute path from workspace_base", async () => {
    // This is the core regression: if provisionAgent tried to mkdir
    // /opt/openclaw/workspace/... it would throw EACCES. Using a temp dir as
    // localBase means the mkdirSync is always within a writable location.
    const fleet = makeFleet("/some/absolute/ec2/path");
    const agent = makeForgeAgent();

    // Must not throw — previously this would EACCES on a non-root machine.
    await assert.doesNotReject(
      () => provisionAgent(fleet, agent, false, tmpDir),
      "provisionAgent must not throw even when workspace_base is an unwritable absolute path"
    );
  });

  // ── Bug 2: no "workspace-" prefix ────────────────────────────────────────

  test("provisionAgent uses <agent_id> (no workspace- prefix) for local dir name", async () => {
    const fleet = makeFleet();
    const agent = makeConductorAgent();

    await provisionAgent(fleet, agent, false, tmpDir);

    // Plain agent id dir should exist.
    const correctDir = path.join(tmpDir, "rendered", "workspaces", "conductor");
    assert.ok(fs.existsSync(correctDir), "rendered/workspaces/conductor/ must exist");

    // "workspace-<id>" variant must NOT exist.
    const wrongDir = path.join(tmpDir, "rendered", "workspaces", "workspace-conductor");
    assert.ok(!fs.existsSync(wrongDir), 'rendered/workspaces/workspace-conductor/ must NOT exist');
  });

  test("provisionFleet creates <id>/ for every agent without workspace- prefix", async () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent(), makeForgeAgent()];

    await provisionFleet(fleet, false, tmpDir);

    const wsBase = path.join(tmpDir, "rendered", "workspaces");
    for (const agentId of ["conductor", "forge"]) {
      assert.ok(fs.existsSync(path.join(wsBase, agentId)), `${agentId}/ must exist`);
      assert.ok(!fs.existsSync(path.join(wsBase, `workspace-${agentId}`)), `workspace-${agentId}/ must NOT exist`);
    }
  });

  // ── Workspace files inside the correct dir ────────────────────────────────

  test("provisionAgent writes SOUL.md, AGENTS.md, IDENTITY.md, USER.md to correct local dir", async () => {
    const fleet = makeFleet();
    const agent = makeConductorAgent();

    await provisionAgent(fleet, agent, false, tmpDir);

    const ws = path.join(tmpDir, "rendered", "workspaces", "conductor");
    for (const file of ["SOUL.md", "AGENTS.md", "IDENTITY.md", "USER.md"]) {
      assert.ok(fs.existsSync(path.join(ws, file)), `${file} must exist in workspace dir`);
    }
  });

  // ── workspace_base preserved in rendered openclaw.json (EC2-side) ─────────

  test("renderOpenClawJson uses workspace_base/<id> (no prefix) for EC2-side workspace path", () => {
    const fleet = makeFleet("/opt/openclaw/workspace");
    fleet.agents.list = [makeConductorAgent(), makeForgeAgent()];

    const json = renderOpenClawJson(fleet) as {
      agents: { list: Array<{ id: string; workspace: string }> };
    };

    for (const entry of json.agents.list) {
      // EC2 workspace path must be workspace_base/<agent_id>
      assert.equal(
        entry.workspace,
        `/opt/openclaw/workspace/${entry.id}`,
        `EC2-side workspace for ${entry.id} must be workspace_base/<id> (no prefix)`
      );

      // Must NOT have the spurious "workspace-" prefix.
      assert.ok(
        !entry.workspace.includes("workspace-"),
        `EC2 workspace path must not contain "workspace-" prefix: got ${entry.workspace}`
      );
    }
  });

  test("renderOpenClawJson preserves workspace_base from fleet.yaml for EC2 consumption", () => {
    const customBase = "/home/ec2-user/.openclaw";
    const fleet = makeFleet(customBase);
    fleet.agents.list = [makeConductorAgent()];

    const json = renderOpenClawJson(fleet) as {
      agents: { list: Array<{ id: string; workspace: string }> };
    };

    assert.equal(
      json.agents.list[0]!.workspace,
      `${customBase}/conductor`,
      "workspace_base from fleet.yaml must be preserved in openclaw.json"
    );
  });

  // ── Cron seeding goes to localBase/rendered/cron/, not workspace_base/cron/ ─

  test("seedCronSweeps writes jobs.json to localBase/rendered/cron/, not workspace_base/cron/", async () => {
    const fleet = makeFleet("/opt/openclaw/workspace");
    const agent = makeConductorAgent();

    await provisionAgent(fleet, agent, false, tmpDir);

    const localCronPath = path.join(tmpDir, "rendered", "cron", "jobs.json");
    assert.ok(fs.existsSync(localCronPath), "cron/jobs.json should be at localBase/rendered/cron/");

    // EC2-side cron dir must NOT be created locally.
    const ec2CronPath = path.join("/opt/openclaw/workspace", "cron");
    assert.ok(!fs.existsSync(ec2CronPath), "workspace_base/cron must NOT be created locally");
  });

  // ── dry-run writes nothing ────────────────────────────────────────────────

  test("dry-run writes no files", async () => {
    const fleet = makeFleet();
    const agent = makeConductorAgent();

    await provisionAgent(fleet, agent, true, tmpDir);

    const renderedDir = path.join(tmpDir, "rendered");
    assert.ok(!fs.existsSync(renderedDir), "rendered/ dir must NOT be created on dry run");
  });
});
