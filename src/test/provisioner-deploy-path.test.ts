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
 *   5. Per-agent openclaw.json slices (renderAgentOpenClawJson) contain only the
 *      named agent's entries for agents.list, bindings, Slack accounts, and a2a allow.
 *   6. writeOutputs emits one file per agent at rendered/openclaw/<agent_id>/openclaw.json.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, describe, beforeEach, afterEach } from "node:test";

import {
  provisionAgent,
  provisionFleet,
  buildFleetRoster,
  resolveSharedIncludes,
} from "../runtime/provisioner.js";
import { renderOpenClawJson, renderAgentOpenClawJson, writeOutputs } from "../runtime/renderer.js";
import type { Fleet, AgentConfig } from "../config/schema.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const EC2_WORKSPACE_BASE = "/opt/openclaw/workspace";

const TEST_TARGET_ID = "ec2-host";

/** Minimal Fleet with an EC2-style target (absolute workspace_base path). */
function makeFleet(workspaceBase = EC2_WORKSPACE_BASE): Fleet {
  const target = {
    id: TEST_TARGET_ID,
    provider: "aws-ssm",
    os: "linux",
    service_manager: "systemd",
    workspace_base: workspaceBase,
    aws: { region: "us-west-2" },
  };
  return {
    fleet: { name: "test-fleet", version: "1.0.0", client: "acme", description: "" },
    targets: { [TEST_TARGET_ID]: target },
    targetMap: new Map([[TEST_TARGET_ID, target]]),
    targetForAgent: () => target,
    agents: {
      defaults: {
        model: "anthropic/claude-sonnet-4-6",
        target: TEST_TARGET_ID,
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
    role: "pm",
    target: TEST_TARGET_ID,
    persona: { soul: "You are Conductor." },
    channels: [{
      provider: "slack",
      account_id: "conductor",
      bot_token: "xoxb-test",
      app_token: "xapp-test",
    }],
    skills: [],
    plugins: ["anthropic"],
    agent_to_agent: { can_send_to: ["forge"] },
    delegation: {
      worker_bots: ["forge"],
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
    role: "backend-worker",
    target: TEST_TARGET_ID,
    persona: { soul: "You are Forge." },
    channels: [{
      provider: "slack",
      account_id: "forge",
      bot_token: "xoxb-forge-test",
      app_token: "xapp-forge-test",
    }],
    skills: [],
    plugins: ["anthropic"],
    agent_to_agent: { can_send_to: ["conductor"] },
    delegation: { specialty: "backend" },
  } as unknown as AgentConfig;
}

/** Replace (or add) an agent's slack channel binding for a test. */
function setSlack(agent: AgentConfig, extra: { bot_user_id?: string; channels?: string[] }): void {
  const base = agent.channels?.find((c) => c.provider === "slack")
    ?? { provider: "slack", account_id: agent.id };
  agent.channels = [{ ...base, ...extra, provider: "slack" }] as unknown as AgentConfig["channels"];
}

// ── Test suite: provisioner deploy path regression ────────────────────────────

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

    // The agent's dir must NOT have been created inside workspace_base on this machine.
    // (Checking the agent subpath, not workspace_base itself, so the test is resilient
    // to workspace_base pre-existing — e.g. when run on an agent EC2.)
    const wrongAgentDir = path.join(EC2_WORKSPACE_BASE, agent.id);
    assert.ok(
      !fs.existsSync(wrongAgentDir),
      `provisionAgent must NOT create ${wrongAgentDir} locally`
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

  test("provisionAgent writes SOUL.md, AGENTS.md, IDENTITY.md, USER.md, HEARTBEAT.md, MEMORY.md to correct local dir", async () => {
    const fleet = makeFleet();
    const agent = makeConductorAgent();

    await provisionAgent(fleet, agent, false, tmpDir);

    const ws = path.join(tmpDir, "rendered", "workspaces", "conductor");
    for (const file of ["SOUL.md", "AGENTS.md", "IDENTITY.md", "USER.md", "HEARTBEAT.md", "MEMORY.md"]) {
      assert.ok(fs.existsSync(path.join(ws, file)), `${file} must exist in workspace dir`);
    }
  });

  test("provisionAgent does not write PATCHES.md (removed in favour of section merge)", async () => {
    const fleet = makeFleet();
    const agent = makeConductorAgent();

    await provisionAgent(fleet, agent, false, tmpDir);

    const ws = path.join(tmpDir, "rendered", "workspaces", "conductor");
    assert.ok(!fs.existsSync(path.join(ws, "PATCHES.md")), "PATCHES.md must not be written to workspace");
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

  // ── dry-run writes nothing ────────────────────────────────────────────────

  test("dry-run writes no files", async () => {
    const fleet = makeFleet();
    const agent = makeConductorAgent();

    await provisionAgent(fleet, agent, true, tmpDir);

    const renderedDir = path.join(tmpDir, "rendered");
    assert.ok(!fs.existsSync(renderedDir), "rendered/ dir must NOT be created on dry run");
  });
});

// ── Per-agent openclaw.json slice tests ──────────────────────────────────────

describe("renderAgentOpenClawJson — per-agent slice", () => {
  // ── agents.list is a single entry ─────────────────────────────────────────

  test("conductor slice contains only conductor in agents.list", () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent(), makeForgeAgent()];

    const json = renderAgentOpenClawJson(fleet, "conductor") as {
      agents: { list: Array<{ id: string }> };
    };

    assert.equal(json.agents.list.length, 1, "agents.list must have exactly one entry");
    assert.equal(json.agents.list[0]!.id, "conductor");
  });

  test("forge slice contains only forge in agents.list", () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent(), makeForgeAgent()];

    const json = renderAgentOpenClawJson(fleet, "forge") as {
      agents: { list: Array<{ id: string }> };
    };

    assert.equal(json.agents.list.length, 1);
    assert.equal(json.agents.list[0]!.id, "forge");
  });

  // ── default: true only on orchestrator ────────────────────────────────────

  test("orchestrator slice has default:true", () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent(), makeForgeAgent()];

    const json = renderAgentOpenClawJson(fleet, "conductor") as {
      agents: { list: Array<{ id: string; default?: boolean }> };
    };

    assert.equal(json.agents.list[0]!.default, true, "orchestrator slice must have default: true");
  });

  test("non-orchestrator slice does NOT have default:true", () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent(), makeForgeAgent()];

    const json = renderAgentOpenClawJson(fleet, "forge") as {
      agents: { list: Array<{ id: string; default?: boolean }> };
    };

    assert.ok(
      json.agents.list[0]!.default !== true,
      "non-orchestrator slice must NOT have default: true"
    );
  });

  // ── bindings — only this agent ─────────────────────────────────────────────

  test("conductor slice has only conductor binding", () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent(), makeForgeAgent()];

    const json = renderAgentOpenClawJson(fleet, "conductor") as {
      bindings: Array<{ agentId: string; match: { accountId: string } }>;
    };

    assert.equal(json.bindings.length, 1);
    assert.equal(json.bindings[0]!.agentId, "conductor");
    assert.equal(json.bindings[0]!.match.accountId, "conductor");
  });

  // ── channels.slack.accounts — only this agent ─────────────────────────────

  test("conductor slice has only conductor Slack account", () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent(), makeForgeAgent()];

    const json = renderAgentOpenClawJson(fleet, "conductor") as {
      channels: { slack: { accounts: Record<string, unknown> } };
    };

    const accounts = json.channels.slack.accounts;
    assert.ok("conductor" in accounts, "conductor account must be present");
    assert.ok(!("forge" in accounts), "forge account must NOT be present in conductor slice");
  });

  // ── tools.agentToAgent.allow — string-array of target agent ids ─────────────

  test("conductor slice a2a allow is a string array of conductor's send targets", () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent(), makeForgeAgent()];

    const json = renderAgentOpenClawJson(fleet, "conductor") as {
      tools: { agentToAgent: { allow: string[] } };
    };

    // Must be plain strings (not objects), containing conductor's can_send_to targets
    for (const entry of json.tools.agentToAgent.allow) {
      assert.equal(
        typeof entry,
        "string",
        `a2a allow entries must be strings, got ${typeof entry}`
      );
    }
    assert.deepEqual(json.tools.agentToAgent.allow, ["forge"]);
  });

  test("forge slice a2a allow is a string array of forge's send targets", () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent(), makeForgeAgent()];

    const json = renderAgentOpenClawJson(fleet, "forge") as {
      tools: { agentToAgent: { allow: string[] } };
    };

    // Must be plain strings (not objects), containing forge's can_send_to targets
    for (const entry of json.tools.agentToAgent.allow) {
      assert.equal(
        typeof entry,
        "string",
        `a2a allow entries must be strings, got ${typeof entry}`
      );
    }
    assert.deepEqual(json.tools.agentToAgent.allow, ["conductor"]);
  });

  test("a2a allow list is sorted and deduplicated", () => {
    const fleet = makeFleet();
    const conductor = makeConductorAgent();
    // Give conductor duplicate + unsorted targets to verify dedup+sort
    conductor.agent_to_agent.can_send_to = ["forge", "forge", "alpha"];
    fleet.agents.list = [conductor, makeForgeAgent()];

    const json = renderAgentOpenClawJson(fleet, "conductor") as {
      tools: { agentToAgent: { allow: string[] } };
    };

    assert.deepEqual(
      json.tools.agentToAgent.allow,
      ["alpha", "forge"],
      "allow list must be sorted alphabetically and deduplicated"
    );
  });

  // ── unknown agentId throws ─────────────────────────────────────────────────────

  // ── hooks block ──────────────────────────────────────────────────────────────

  test("renderAgentOpenClawJson emits hooks.enabled, token env-var placeholder, path, and allowedAgentIds", () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent()];
    const json = renderAgentOpenClawJson(fleet, "conductor") as { hooks: Record<string, unknown> };
    const hooks = json.hooks;

    assert.ok(hooks, "hooks block must be present");
    assert.equal(hooks.enabled, true, "hooks.enabled must be true");
    assert.equal(hooks.token, "${OPENCLAW_HOOKS_TOKEN}",
      "hooks.token must be the canonical OPENCLAW_HOOKS_TOKEN env-var placeholder");
    assert.equal(hooks.path, "/hooks", "hooks.path must be /hooks");
    assert.deepEqual(hooks.allowedAgentIds, ["main"],
      "hooks.allowedAgentIds must default to [\"main\"]");
  });

  test("renderAgentOpenClawJson hooks.token is always OPENCLAW_HOOKS_TOKEN regardless of agent id", () => {
    const fleet = makeFleet();
    const myAgent: AgentConfig = { ...makeForgeAgent(), id: "my-agent" as AgentConfig["id"], name: "My Agent" };
    fleet.agents.list = [myAgent];
    const json = renderAgentOpenClawJson(fleet, "my-agent") as { hooks: Record<string, unknown> };
    assert.equal(json.hooks.token, "${OPENCLAW_HOOKS_TOKEN}",
      "hooks.token is always the canonical OPENCLAW_HOOKS_TOKEN env-var");
  });

  test("renderAgentOpenClawJson hooks.enabled respects fleet openclaw.hooks.enabled=false", () => {
    const fleet = makeFleet();
    (fleet.openclaw as Record<string, unknown>).hooks = { enabled: false, path: "/hooks", allowed_agent_ids: ["main"] };
    fleet.agents.list = [makeConductorAgent()];
    const json = renderAgentOpenClawJson(fleet, "conductor") as { hooks: Record<string, unknown> };
    assert.equal(json.hooks.enabled, false, "hooks.enabled must honour fleet config");
  });

  test("renderAgentOpenClawJson hooks.allowedAgentIds respects custom allowed_agent_ids", () => {
    const fleet = makeFleet();
    (fleet.openclaw as Record<string, unknown>).hooks = { enabled: true, path: "/hooks", allowed_agent_ids: ["main", "hooks-agent"] };
    fleet.agents.list = [makeConductorAgent()];
    const json = renderAgentOpenClawJson(fleet, "conductor") as { hooks: Record<string, unknown> };
    assert.deepEqual(json.hooks.allowedAgentIds, ["main", "hooks-agent"]);
  });

  test("renderAgentOpenClawJson hooks block still includes internal hooks", () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent()];
    const json = renderAgentOpenClawJson(fleet, "conductor") as {
      hooks: { internal: { enabled: boolean; entries: Record<string, unknown> } }
    };
    assert.equal(json.hooks.internal.enabled, true);
    assert.ok(json.hooks.internal.entries["boot-md"], "boot-md hook must be present");
    assert.ok(json.hooks.internal.entries["session-memory"], "session-memory hook must be present");
  });

  test("renderAgentOpenClawJson throws for unknown agentId", () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent()];

    assert.throws(
      () => renderAgentOpenClawJson(fleet, "nonexistent"),
      /nonexistent/,
      "should throw with the unknown agent id in the message"
    );
  });

  // ── Fix 1: messages.visibleReplies defaults ───────────────────────────────────

  test("renderer emits messages.visibleReplies=automatic for every agent slice", () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent(), makeForgeAgent()];

    for (const agentId of ["conductor", "forge"]) {
      const json = renderAgentOpenClawJson(fleet, agentId) as {
        messages: { visibleReplies: string; groupChat: { visibleReplies: string } };
      };
      assert.equal(
        json.messages.visibleReplies,
        "automatic",
        `${agentId} slice must have messages.visibleReplies = "automatic"`
      );
      assert.equal(
        json.messages.groupChat.visibleReplies,
        "automatic",
        `${agentId} slice must have messages.groupChat.visibleReplies = "automatic"`
      );
    }
  });

  // ── Fix 3: top-level groupPolicy = "allowlist" ─────────────────────────────

  test("renderer emits channels.slack.groupPolicy=allowlist at top level", () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent(), makeForgeAgent()];

    const json = renderAgentOpenClawJson(fleet, "conductor") as {
      channels: { slack: { groupPolicy: string; accounts: Record<string, unknown> } };
    };

    assert.equal(
      json.channels.slack.groupPolicy,
      "allowlist",
      "groupPolicy must be 'allowlist' at channels.slack level"
    );

    // Must NOT appear on individual accounts
    const conductorAccount = json.channels.slack.accounts["conductor"] as Record<string, unknown> | undefined;
    assert.ok(
      conductorAccount !== undefined,
      "conductor account must exist"
    );
    assert.ok(
      !("groupPolicy" in conductorAccount!),
      "groupPolicy must NOT appear under channels.slack.accounts.<id>"
    );
  });

  // ── Fix 2: per-channel users allowlist for inter-bot delivery ─────────────

  test("each agent's slice has the other's bot_user_id in shared channel users", () => {
    // Two agents both operating in channel C1, both with bot_user_ids set
    const fleet = makeFleet();
    const alpha = makeConductorAgent();
    setSlack(alpha, { bot_user_id: "UALPHA", channels: ["C1"] });
    const beta = makeForgeAgent();
    setSlack(beta, { bot_user_id: "UBETA", channels: ["C1"] });
    fleet.agents.list = [alpha, beta];

    const alphaJson = renderAgentOpenClawJson(fleet, "conductor") as {
      channels: { slack: { channels: Record<string, { users?: string[] }> } };
    };
    const betaJson = renderAgentOpenClawJson(fleet, "forge") as {
      channels: { slack: { channels: Record<string, { users?: string[] }> } };
    };

    assert.deepEqual(
      alphaJson.channels.slack.channels["C1"]!.users,
      ["UBETA", "*"],
      "alpha's C1 users allowlist must contain beta's bot_user_id and the wildcard"
    );
    assert.deepEqual(
      betaJson.channels.slack.channels["C1"]!.users,
      ["UALPHA", "*"],
      "beta's C1 users allowlist must contain alpha's bot_user_id and the wildcard"
    );
  });

  test("no users field when shared-channel peer has no bot_user_id", () => {
    // Agent B has no bot_user_id; agent A's slice for the shared channel must have no users field
    const fleet = makeFleet();
    const alpha = makeConductorAgent();
    setSlack(alpha, { bot_user_id: "UALPHA", channels: ["C1"] });
    const beta = makeForgeAgent();
    // bot_user_id intentionally omitted
    setSlack(beta, { channels: ["C1"] });
    fleet.agents.list = [alpha, beta];

    const alphaJson = renderAgentOpenClawJson(fleet, "conductor") as {
      channels: { slack: { channels: Record<string, { users?: string[] }> } };
    };

    const c1Entry = alphaJson.channels.slack.channels["C1"]!;
    // When peers have no bot_user_id, users must still include "*" so humans are not blocked
    assert.deepEqual(
      c1Entry.users,
      ["*"],
      "C1 entry must have users: ['*'] even when peer has no bot_user_id"
    );
  });

  test("first channel has requireMention=false, subsequent channels requireMention=true", () => {
    const fleet = makeFleet();
    const alpha = makeConductorAgent();
    setSlack(alpha, { bot_user_id: "UALPHA", channels: ["CHOME", "CSECOND", "CTHIRD"] });
    fleet.agents.list = [alpha];

    const json = renderAgentOpenClawJson(fleet, "conductor") as {
      channels: { slack: { channels: Record<string, { requireMention: boolean }> } };
    };

    assert.equal(
      json.channels.slack.channels["CHOME"]!.requireMention,
      false,
      "first (home) channel must have requireMention: false"
    );
    assert.equal(
      json.channels.slack.channels["CSECOND"]!.requireMention,
      true,
      "second channel must have requireMention: true"
    );
    assert.equal(
      json.channels.slack.channels["CTHIRD"]!.requireMention,
      true,
      "third channel must have requireMention: true"
    );
  });
});


// ── renderAgentOpenClawJson — cacheRetention forwarding ─────────────────────

describe("renderAgentOpenClawJson — cacheRetention forwarding", () => {
  test("emits agents.defaults.params.cacheRetention when set in fleet defaults", () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent(), makeForgeAgent()];
    fleet.agents.defaults = {
      ...fleet.agents.defaults,
      params: { cacheRetention: "short" },
    };

    const json = renderAgentOpenClawJson(fleet, "conductor") as {
      agents: { defaults: { params?: { cacheRetention?: string }; models?: Record<string, { params?: { cacheRetention?: string } }> } };
    };
    assert.equal(
      json.agents.defaults.params?.cacheRetention,
      "short",
      'agents.defaults.params.cacheRetention must be "short"'
    );
  });

  test("emits agents.defaults.models per-model override when set", () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent(), makeForgeAgent()];
    fleet.agents.defaults = {
      ...fleet.agents.defaults,
      params: { cacheRetention: "short" },
      models: {
        "anthropic/claude-sonnet-4-6": { params: { cacheRetention: "long" } },
      },
    };

    const json = renderAgentOpenClawJson(fleet, "conductor") as {
      agents: { defaults: { params?: { cacheRetention?: string }; models?: Record<string, { params?: { cacheRetention?: string } }> } };
    };
    assert.equal(
      json.agents.defaults.params?.cacheRetention,
      "short",
      'global default must be "short"'
    );
    assert.equal(
      json.agents.defaults.models?.["anthropic/claude-sonnet-4-6"]?.params?.cacheRetention,
      "long",
      'per-model Sonnet override must be "long"'
    );
  });

  test("omits agents.defaults.params when not set in fleet defaults", () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent()];
    fleet.agents.defaults = { model: "anthropic/claude-haiku-4-5", target: TEST_TARGET_ID as AgentConfig["target"], plugins: ["anthropic"], timeout_seconds: 300 };

    const json = renderAgentOpenClawJson(fleet, "conductor") as {
      agents: { defaults: { params?: unknown; models?: unknown } };
    };
    assert.equal(json.agents.defaults.params, undefined, "params must be absent when not configured");
    assert.equal(json.agents.defaults.models, undefined, "models must be absent when not configured");
  });
});

// ── writeOutputs — per-agent file layout ──────────────────────────────────────

describe("writeOutputs — per-agent file layout", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetmind-write-outputs-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writes per-agent openclaw.json under <ocBase>/<agent_id>/", () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent(), makeForgeAgent()];

    writeOutputs(fleet, tmpDir);

    // Default openclaw_json is ./rendered/openclaw.json
    // resolveOpenClawBaseDir strips .json → ./rendered/openclaw/
    for (const agentId of ["conductor", "forge"]) {
      const expected = path.join(tmpDir, "rendered", "openclaw", agentId, "openclaw.json");
      assert.ok(fs.existsSync(expected), `${expected} must exist`);
    }
  });

  test("each per-agent file contains only that agent's data", () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent(), makeForgeAgent()];

    writeOutputs(fleet, tmpDir);

    const conductorJson = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "rendered", "openclaw", "conductor", "openclaw.json"), "utf8")
    ) as { agents: { list: Array<{ id: string }> } };

    assert.equal(conductorJson.agents.list.length, 1);
    assert.equal(conductorJson.agents.list[0]!.id, "conductor");

    const forgeJson = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "rendered", "openclaw", "forge", "openclaw.json"), "utf8")
    ) as { agents: { list: Array<{ id: string }> } };

    assert.equal(forgeJson.agents.list.length, 1);
    assert.equal(forgeJson.agents.list[0]!.id, "forge");
  });

  test("writeOutputs result keys include openclaw_json:<agent_id> for each agent", () => {
    const fleet = makeFleet();
    fleet.agents.list = [makeConductorAgent(), makeForgeAgent()];

    const written = writeOutputs(fleet, tmpDir);

    assert.ok("openclaw_json:conductor" in written, "written must have openclaw_json:conductor key");
    assert.ok("openclaw_json:forge" in written, "written must have openclaw_json:forge key");
  });
});

// ── Role-template rendering tests ─────────────────────────────────────────────

describe("role-template rendering", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetmind-role-template-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("provisionAgent with role:pm reads from openclaw/pm-bot/workspace/AGENTS.md and substitutes placeholders", async () => {
    const fleet = makeFleet();
    const agent = makeConductorAgent(); // role: "pm"

    await provisionAgent(fleet, agent, false, tmpDir);

    const agentsMdPath = path.join(tmpDir, "rendered", "workspaces", "conductor", "AGENTS.md");
    const content = fs.readFileSync(agentsMdPath, "utf8");

    // Must contain a phrase from the pm-bot template (not the inline stub)
    assert.ok(
      content.includes("bot-delegation"),
      "AGENTS.md should reference 'bot-delegation' from the pm-bot template"
    );

    // Must NOT contain the inline-stub phrase
    assert.ok(
      !content.includes("Specialist: handles delegated tasks from the orchestrator"),
      "AGENTS.md must NOT contain the inline stub phrase when role template is used"
    );
  });

  test("provisionAgent substitutes {{NAME}} {{EMOJI}} {{DESCRIPTION}} {{SOUL_BODY}}", async () => {
    const fleet = makeFleet();
    const agent: AgentConfig = {
      id: "testbot",
      name: "TestBot",
      emoji: "🧪",
      description: "a test agent",
      orchestrator: false,
      role: "backend-worker",
      persona: { soul: "test soul body" },
      slack: { account_id: "testbot", bot_token: "xoxb-test", app_token: "xapp-test" },
      skills: [],
      plugins: ["anthropic"],
      agent_to_agent: { can_send_to: [] },
    } as unknown as AgentConfig;

    await provisionAgent(fleet, agent, false, tmpDir);

    const ws = path.join(tmpDir, "rendered", "workspaces", "testbot");

    for (const filename of ["SOUL.md", "AGENTS.md", "IDENTITY.md"]) {
      const content = fs.readFileSync(path.join(ws, filename), "utf8");
      assert.ok(
        !content.includes("{{"),
        `${filename} must not contain any unresolved {{ placeholders after substitution`
      );
    }

    const soulContent = fs.readFileSync(path.join(ws, "SOUL.md"), "utf8");
    assert.ok(soulContent.includes("TestBot"), "SOUL.md must include the agent name");
    assert.ok(soulContent.includes("🧪"), "SOUL.md must include the emoji");
    assert.ok(soulContent.includes("test soul body"), "SOUL.md must include SOUL_BODY from persona.soul");

    const identityContent = fs.readFileSync(path.join(ws, "IDENTITY.md"), "utf8");
    assert.ok(identityContent.includes("TestBot"), "IDENTITY.md must include the agent name");
    assert.ok(identityContent.includes("🧪"), "IDENTITY.md must include the emoji");
    assert.ok(identityContent.includes("a test agent"), "IDENTITY.md must include the description");
  });

  test("specialist worker AGENTS.md routes human direct asks through worker-self-start", async () => {
    const cases: Array<{ agent: AgentConfig; id: string }> = [
      {
        id: "backend",
        agent: {
          id: "backend",
          name: "Backend",
          emoji: "⚙️",
          description: "backend specialist",
          orchestrator: false,
          role: "backend-worker",
          persona: { soul: "backend soul" },
          slack: { account_id: "backend", bot_token: "xoxb-backend", app_token: "xapp-backend" },
          skills: [],
          plugins: ["anthropic"],
          agent_to_agent: { can_send_to: [] },
        } as unknown as AgentConfig,
      },
      {
        id: "frontend",
        agent: {
          id: "frontend",
          name: "Frontend",
          emoji: "🎨",
          description: "frontend specialist",
          orchestrator: false,
          role: "frontend-worker",
          persona: { soul: "frontend soul" },
          slack: { account_id: "frontend", bot_token: "xoxb-frontend", app_token: "xapp-frontend" },
          skills: [],
          plugins: ["anthropic"],
          agent_to_agent: { can_send_to: [] },
        } as unknown as AgentConfig,
      },
    ];

    for (const { agent, id } of cases) {
      await provisionAgent(makeFleet(), agent, false, tmpDir);
      const content = fs.readFileSync(
        path.join(tmpDir, "rendered", "workspaces", id, "AGENTS.md"),
        "utf8"
      );

      assert.ok(
        content.includes("Human asks you to start work without a PM delegation | `worker-self-start`"),
        `${id} AGENTS.md must point human direct work at worker-self-start`
      );
      assert.ok(
        content.includes("Create the row BEFORE posting the self-start notice"),
        `${id} AGENTS.md must preserve SF-2 ordering`
      );
    }
  });

  test("provisionAgent falls back to inline stub when role-template file is missing", async () => {
    // worker-bot/workspace/ has no IDENTITY.md — verifies the fallback path
    const fleet = makeFleet();
    const agent: AgentConfig = {
      id: "genericbot",
      name: "GenericBot",
      emoji: "🤖",
      description: "a generic worker",
      orchestrator: false,
      role: "worker",
      persona: { soul: "You are a generic worker." },
      slack: { account_id: "genericbot", bot_token: "xoxb-test", app_token: "xapp-test" },
      skills: [],
      plugins: ["anthropic"],
      agent_to_agent: { can_send_to: [] },
    } as unknown as AgentConfig;

    // Must not throw even though worker-bot/workspace/IDENTITY.md doesn't exist
    await assert.doesNotReject(
      () => provisionAgent(fleet, agent, false, tmpDir),
      "provisionAgent must not throw when role-template file is missing"
    );

    const ws = path.join(tmpDir, "rendered", "workspaces", "genericbot");
    const identityContent = fs.readFileSync(path.join(ws, "IDENTITY.md"), "utf8");

    // Inline fallback produces the identityMd() stub with Name/Emoji/Role/Description
    assert.ok(
      identityContent.includes("GenericBot"),
      "fallback IDENTITY.md must include the agent name from inline stub"
    );
    assert.ok(
      identityContent.includes("Specialist"),
      "fallback IDENTITY.md must include 'Specialist' from the inline identityMd() stub"
    );
  });

  // ── Shared workspace template fallback (HEARTBEAT.md / MEMORY.md / TOOLS.md) ──

  test("provisionAgent seeds TOOLS.md for pm and backend-worker roles via the shared template fallback", async () => {
    // Regression test for the documented drift: pm-bot/workspace/ and
    // backend-worker-bot/workspace/ ship no role-specific TOOLS.md, yet every
    // role's AGENTS.md Session Boot step instructs the agent to read TOOLS.md.
    // readRoleTemplate now falls back to openclaw/_shared/workspace/TOOLS.md
    // for any role dir that doesn't ship its own copy.
    for (const { agent, id } of [
      { agent: makeConductorAgent(), id: "conductor" }, // role: pm
      { agent: makeForgeAgent(), id: "forge" }, // role: backend-worker
    ]) {
      const fleet = makeFleet();
      await provisionAgent(fleet, agent, false, tmpDir);

      const toolsPath = path.join(tmpDir, "rendered", "workspaces", id, "TOOLS.md");
      assert.ok(fs.existsSync(toolsPath), `${id}: TOOLS.md must be seeded (was previously missing)`);

      const content = fs.readFileSync(toolsPath, "utf8");
      assert.ok(
        content.includes("Environment Notes"),
        `${id}: TOOLS.md content should come from the shared template`
      );
      // Placeholders must be substituted, not left dangling.
      assert.ok(!content.includes("{{"), `${id}: TOOLS.md must not contain unsubstituted placeholders`);
    }
  });

  test("HEARTBEAT.md and MEMORY.md are identical for every bundled role via the shared template", async () => {
    const roles: Array<{ agent: AgentConfig; id: string }> = [
      { agent: makeConductorAgent(), id: "conductor" }, // pm
      { agent: makeForgeAgent(), id: "forge" }, // backend-worker
    ];

    const results: Record<string, { heartbeat: string; memory: string }> = {};
    for (const { agent, id } of roles) {
      const fleet = makeFleet();
      const ws = path.join(tmpDir, id);
      await provisionAgent(fleet, agent, false, ws);
      results[id] = {
        heartbeat: fs.readFileSync(path.join(ws, "rendered", "workspaces", id, "HEARTBEAT.md"), "utf8"),
        memory: fs.readFileSync(path.join(ws, "rendered", "workspaces", id, "MEMORY.md"), "utf8"),
      };
    }

    assert.equal(results.conductor!.heartbeat, results.forge!.heartbeat);
    assert.equal(results.conductor!.memory, results.forge!.memory);
  });

  // ── Shared AGENTS.md sub-section partials (SHARED-INCLUDE) ──────────────────

  test("resolveSharedIncludes swaps a SHARED-INCLUDE marker for the referenced partial's content", () => {
    const rendered = resolveSharedIncludes(
      "## Host Tools\n\n<!-- SHARED-INCLUDE: host-tools.md -->\n\n<!-- AUTO SECTION -->\n## Next Section\n"
    );

    assert.ok(!rendered.includes("SHARED-INCLUDE"), "marker line must be fully replaced");
    assert.ok(rendered.includes("gh-app-token"), "partial content must be inlined");
    assert.ok(rendered.includes("## Next Section"), "content after the marker must be preserved");
  });

  test("resolveSharedIncludes throws when the referenced partial doesn't exist", () => {
    assert.throws(
      () => resolveSharedIncludes("<!-- SHARED-INCLUDE: does-not-exist.md -->"),
      /does not exist/,
      "a typo'd shared partial filename must fail loudly, not ship a bare marker line"
    );
  });

  test("text with no SHARED-INCLUDE marker passes through unchanged", () => {
    const text = "## Host Tools\n\nplain content, no markers here.\n";
    assert.equal(resolveSharedIncludes(text), text);
  });

  test("every bundled role's rendered AGENTS.md Host Tools section shares one gh-app-token source (no per-role duplication)", async () => {
    const roles: Array<{ agent: AgentConfig; id: string }> = [
      { agent: makeConductorAgent(), id: "conductor" }, // pm
      { agent: makeForgeAgent(), id: "forge" }, // backend-worker
      {
        agent: {
          id: "pixel",
          name: "Pixel",
          emoji: "🎨",
          description: "frontend specialist",
          orchestrator: false,
          role: "frontend-worker",
          persona: { soul: "frontend soul" },
          slack: { account_id: "pixel", bot_token: "xoxb-pixel", app_token: "xapp-pixel" },
          skills: [],
          plugins: ["anthropic"],
          agent_to_agent: { can_send_to: [] },
        } as unknown as AgentConfig,
        id: "pixel",
      },
      {
        agent: {
          id: "genericworker",
          name: "GenericWorker",
          emoji: "🤖",
          description: "generic worker",
          orchestrator: false,
          role: "worker",
          persona: { soul: "generic worker soul" },
          slack: { account_id: "genericworker", bot_token: "xoxb-generic", app_token: "xapp-generic" },
          skills: [],
          plugins: ["anthropic"],
          agent_to_agent: { can_send_to: [] },
        } as unknown as AgentConfig,
        id: "genericworker",
      },
    ];

    for (const { agent, id } of roles) {
      const fleet = makeFleet();
      await provisionAgent(fleet, agent, false, tmpDir);

      const content = fs.readFileSync(
        path.join(tmpDir, "rendered", "workspaces", id, "AGENTS.md"),
        "utf8"
      );

      assert.ok(!content.includes("SHARED-INCLUDE"), `${id}: AGENTS.md must not leak the include marker`);
      assert.ok(!content.includes("{{"), `${id}: AGENTS.md must not contain unsubstituted placeholders`);

      const hostToolsCount = content.split("## Host Tools").length - 1;
      assert.equal(hostToolsCount, 1, `${id}: AGENTS.md must have exactly one Host Tools section`);

      const ghAppTokenCount = content.split("### `gh-app-token`").length - 1;
      assert.equal(ghAppTokenCount, 1, `${id}: AGENTS.md must have exactly one gh-app-token block (no duplication)`);

      assert.ok(
        content.includes("ssm:GetParameter"),
        `${id}: AGENTS.md Host Tools section must retain the SSM IAM-grant troubleshooting note`
      );
    }
  });
});

// =============================================================================
// Fleet roster section tests
// =============================================================================

describe("fleet roster — buildFleetRoster", () => {
  function makeFleetWithAgents(agents: AgentConfig[]): Fleet {
    const fleet = makeFleet();
    fleet.agents.list = agents;
    return fleet;
  }

  function makePmAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
      id: "conductor",
      name: "Conductor",
      emoji: "🎼",
      description: "PM bot that orchestrates",
      orchestrator: true,
      role: "pm",
      target: TEST_TARGET_ID,
      persona: { soul: "You are Conductor." },
      channels: [{
        provider: "slack",
        account_id: "conductor",
        bot_token: "xoxb-conductor",
        app_token: "xapp-conductor",
        bot_user_id: "U0CONDUCTOR",
        channels: ["C0PMCHANNEL"],
      }],
      skills: [],
      plugins: ["anthropic"],
      agent_to_agent: { can_send_to: [] },
      ...overrides,
    } as unknown as AgentConfig;
  }

  function makeWorkerAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
      id: "forge",
      name: "Forge",
      emoji: "⚙️",
      description: "Backend worker",
      orchestrator: false,
      role: "backend-worker",
      target: TEST_TARGET_ID,
      persona: { soul: "You are Forge." },
      channels: [{
        provider: "slack",
        account_id: "forge",
        bot_token: "xoxb-forge",
        app_token: "xapp-forge",
        bot_user_id: "U0FORGE",
        channels: ["C0DEVCHANNEL", "C0SECONDCHAN"],
      }],
      skills: [],
      plugins: ["anthropic"],
      agent_to_agent: { can_send_to: [] },
      ...overrides,
    } as unknown as AgentConfig;
  }

  function makeFrontendAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
      id: "pixel",
      name: "Pixel",
      emoji: "🎨",
      description: "Frontend worker",
      orchestrator: false,
      role: "frontend-worker",
      target: TEST_TARGET_ID,
      persona: { soul: "You are Pixel." },
      channels: [{
        provider: "slack",
        account_id: "pixel",
        bot_token: "xoxb-pixel",
        app_token: "xapp-pixel",
        bot_user_id: "U0PIXEL",
        channels: ["C0DEVCHANNEL"],
      }],
      skills: [],
      plugins: ["anthropic"],
      agent_to_agent: { can_send_to: [] },
      ...overrides,
    } as unknown as AgentConfig;
  }

  test("two-agent fleet: PM roster lists worker (not self)", () => {
    const pm = makePmAgent();
    const worker = makeWorkerAgent();
    const fleet = makeFleetWithAgents([pm, worker]);

    const roster = buildFleetRoster(fleet, pm);

    // Must include fleet name
    assert.ok(roster.includes("test-fleet"), "roster must include fleet name");
    // Must list the worker
    assert.ok(roster.includes("Forge"), "PM roster must list worker Forge");
    assert.ok(roster.includes("U0FORGE"), "PM roster must include worker's bot_user_id");
    assert.ok(roster.includes("<@U0FORGE>"), "PM roster must include worker's mention");
    assert.ok(roster.includes("C0DEVCHANNEL"), "PM roster must include worker's channels");
    assert.ok(roster.includes("Backend worker"), "PM roster must include worker's role label");
    // Must NOT include self
    assert.ok(!roster.includes("Conductor"), "PM roster must not list self");
    assert.ok(!roster.includes("U0CONDUCTOR"), "PM roster must not include own user_id");
  });

  test("two-agent fleet: worker roster lists PM (not self)", () => {
    const pm = makePmAgent();
    const worker = makeWorkerAgent();
    const fleet = makeFleetWithAgents([pm, worker]);

    const roster = buildFleetRoster(fleet, worker);

    assert.ok(roster.includes("Conductor"), "worker roster must list PM");
    assert.ok(roster.includes("U0CONDUCTOR"), "worker roster must include PM's bot_user_id");
    assert.ok(roster.includes("<@U0CONDUCTOR>"), "worker roster must include PM mention");
    assert.ok(roster.includes("PM (orchestrator)"), "worker roster must include PM role label");
    // Must NOT include self
    assert.ok(!roster.includes("Forge"), "worker roster must not list self");
  });

  test("three-agent fleet: each agent's roster lists exactly 2 others", () => {
    const pm = makePmAgent();
    const worker = makeWorkerAgent();
    const frontend = makeFrontendAgent();
    const fleet = makeFleetWithAgents([pm, worker, frontend]);

    const pmRoster = buildFleetRoster(fleet, pm);
    assert.ok(pmRoster.includes("Forge"), "PM roster must list Forge");
    assert.ok(pmRoster.includes("Pixel"), "PM roster must list Pixel");
    assert.ok(!pmRoster.includes("Conductor"), "PM roster must not list self");

    const workerRoster = buildFleetRoster(fleet, worker);
    assert.ok(workerRoster.includes("Conductor"), "worker roster must list PM");
    assert.ok(workerRoster.includes("Pixel"), "worker roster must list frontend peer");
    assert.ok(!workerRoster.includes("Forge"), "worker roster must not list self");

    const frontendRoster = buildFleetRoster(fleet, frontend);
    assert.ok(frontendRoster.includes("Conductor"), "frontend roster must list PM");
    assert.ok(frontendRoster.includes("Forge"), "frontend roster must list backend worker");
    assert.ok(!frontendRoster.includes("Pixel"), "frontend roster must not list self");
  });

  test("solo fleet: roster says no peers configured", () => {
    const pm = makePmAgent();
    const fleet = makeFleetWithAgents([pm]);

    const roster = buildFleetRoster(fleet, pm);

    assert.ok(roster.includes("solo bot"), "solo roster must say 'solo bot'");
    assert.ok(roster.includes("No peer bots configured"), "solo roster must say no peers");
    assert.ok(roster.includes("test-fleet"), "solo roster must include fleet name");
    // Must not have any peer listing lines
    assert.ok(!roster.includes("Slack user:"), "solo roster must not have any peer Slack user lines");
  });

  test("missing bot_user_id shown as TODO marker", () => {
    const pm = makePmAgent();
    // Worker has no bot_user_id
    const worker = makeWorkerAgent({
      channels: [{
        provider: "slack",
        account_id: "forge",
        bot_token: "xoxb-forge",
        app_token: "xapp-forge",
        channels: ["C0DEVCHANNEL"],
      }] as unknown as AgentConfig["channels"],
    });
    const fleet = makeFleetWithAgents([pm, worker]);

    const roster = buildFleetRoster(fleet, pm);

    assert.ok(roster.includes("TODO (run fleetmind slack discover)"), "missing user_id must show TODO marker");
    // Still lists the peer
    assert.ok(roster.includes("Forge"), "peer without user_id must still be listed");
  });

  test("{{FLEET_ROSTER}} placeholder is replaced in rendered AGENTS.md (no {{ remains)", async () => {
    const pm = makePmAgent();
    const worker = makeWorkerAgent();
    const fleet = makeFleetWithAgents([pm, worker]);
    fleet.agents.list = [pm, worker];

    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "fleetmind-roster-placeholder-"));
    try {
      await provisionAgent(fleet, pm, false, tmpDir2);
      const agentsMdPath = path.join(tmpDir2, "rendered", "workspaces", "conductor", "AGENTS.md");
      const content = fs.readFileSync(agentsMdPath, "utf8");
      assert.ok(!content.includes("{{"), "no {{ should remain in rendered AGENTS.md");
      assert.ok(content.includes("## Fleet Members"), "Fleet Members section must be present");
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  test("role label mapping is correct for all roles", () => {
    const pm = makePmAgent();
    const backendWorker = makeWorkerAgent({ role: "backend-worker" } as Partial<AgentConfig>);
    const frontendWorker = makeFrontendAgent({ role: "frontend-worker" } as Partial<AgentConfig>);
    const genericWorker = makeWorkerAgent({ id: "plain", name: "Plain", role: "worker" } as Partial<AgentConfig>);

    const fleet = makeFleetWithAgents([pm, backendWorker, frontendWorker, genericWorker]);

    // From PM's perspective, all workers should have correct role labels
    const roster = buildFleetRoster(fleet, pm);
    assert.ok(roster.includes("Backend worker"), "backend-worker must map to 'Backend worker'");
    assert.ok(roster.includes("Frontend worker"), "frontend-worker must map to 'Frontend worker'");
    assert.ok(roster.includes("Worker"), "worker must map to 'Worker'");
    // PM's own label from any peer's perspective:
    const workerRoster = buildFleetRoster(fleet, backendWorker);
    assert.ok(workerRoster.includes("PM (orchestrator)"), "pm must map to 'PM (orchestrator)'");
  });

  test("channels list is formatted as comma-separated channel IDs", () => {
    const pm = makePmAgent();
    const worker = makeWorkerAgent(); // has ["C0DEVCHANNEL", "C0SECONDCHAN"]
    const fleet = makeFleetWithAgents([pm, worker]);

    const roster = buildFleetRoster(fleet, pm);
    // Both channel IDs must appear and be joined with a comma
    assert.ok(roster.includes("C0DEVCHANNEL, C0SECONDCHAN"), "channels must be comma-separated");
  });
});
