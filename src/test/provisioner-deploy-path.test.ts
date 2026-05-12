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
 *   6. Per-agent openclaw.json slices (renderAgentOpenClawJson) contain only the
 *      named agent's entries for agents.list, bindings, Slack accounts, and a2a allow.
 *   7. writeOutputs emits one file per agent at rendered/openclaw/<agent_id>/openclaw.json.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, describe, beforeEach, afterEach } from "node:test";

import { provisionAgent, provisionFleet } from "../runtime/provisioner.js";
import { renderOpenClawJson, renderAgentOpenClawJson, writeOutputs } from "../runtime/renderer.js";
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
    role: "pm",
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
    role: "backend-worker",
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
    alpha.slack = {
      ...alpha.slack,
      bot_user_id: "UALPHA",
      channels: ["C1"],
    } as typeof alpha.slack;
    const beta = makeForgeAgent();
    beta.slack = {
      ...beta.slack,
      bot_user_id: "UBETA",
      channels: ["C1"],
    } as typeof beta.slack;
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
    alpha.slack = {
      ...alpha.slack,
      bot_user_id: "UALPHA",
      channels: ["C1"],
    } as typeof alpha.slack;
    const beta = makeForgeAgent();
    beta.slack = {
      ...beta.slack,
      // bot_user_id intentionally omitted
      channels: ["C1"],
    } as typeof beta.slack;
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
    alpha.slack = {
      ...alpha.slack,
      bot_user_id: "UALPHA",
      channels: ["CHOME", "CSECOND", "CTHIRD"],
    } as typeof alpha.slack;
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
});
