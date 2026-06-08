/**
 * Integration tests for `fleetmind onboard` wizard.
 *
 * Tests the wizard end-to-end using the OnboardDeps injection seam —
 * all AWS I/O, file I/O, and terminal interaction is mocked.
 * loadFleet() still uses real temp files so the Zod schema is exercised.
 *
 * Covers:
 *   - Happy paths (delegation: false / delegation: true)
 *   - Step 9 provider-prompt matrix
 *   - Idempotency (step 3 skip, step 5 skip, partial step 9)
 *   - Fallback paths (--legacy-github-apps, empty-owner fallback)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, describe, beforeEach, afterEach } from "node:test";

import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";

import { runOnboard, type OnboardDeps } from "../cli/commands/onboard.js";
import { loadFleet } from "../config/loader.js";
import type { PushFleetResult } from "../cli/commands/push-fleet.js";

// ── Mock builders ─────────────────────────────────────────────────────────────

/**
 * Tracked prompter call — type, question text, defaultYes (for confirm only).
 */
interface PrompterCall {
  type: "confirm" | "prompt" | "hidden";
  question: string;
  defaultYes?: boolean;
}

interface MockPrompter {
  calls: PrompterCall[];
  prompter: OnboardDeps["prompter"];
}

/**
 * Queue-based prompter mock.
 * - `confirmAnswers`: dequeued in order for every confirm() call
 * - `promptAnswers`: dequeued in order for every prompt() call
 * - `hiddenAnswers`: dequeued in order for every hiddenPrompt() call
 *
 * Throws descriptively if a queue is exhausted unexpectedly.
 */
function makeMockPrompter(
  confirmAnswers: boolean[],
  promptAnswers: string[] = [],
  hiddenAnswers: string[] = [],
): MockPrompter {
  const cq = [...confirmAnswers];
  const pq = [...promptAnswers];
  const hq = [...hiddenAnswers];
  const calls: PrompterCall[] = [];

  return {
    calls,
    prompter: {
      confirm: async (question: string, defaultYes = true) => {
        calls.push({ type: "confirm", question, defaultYes });
        const answer = cq.shift();
        if (answer === undefined) {
          throw new Error(
            `MockPrompter: unexpected confirm("${question}") — confirm queue exhausted.\n` +
              `Remaining prompt queue: ${JSON.stringify(pq)}\n` +
              `Remaining hidden queue: ${JSON.stringify(hq)}`,
          );
        }
        return answer;
      },
      prompt: async (question: string) => {
        calls.push({ type: "prompt", question });
        const answer = pq.shift();
        if (answer === undefined) {
          throw new Error(
            `MockPrompter: unexpected prompt("${question}") — prompt queue exhausted.`,
          );
        }
        return answer;
      },
      hiddenPrompt: async (question: string) => {
        calls.push({ type: "hidden", question });
        const answer = hq.shift();
        if (answer === undefined) {
          throw new Error(
            `MockPrompter: unexpected hiddenPrompt("${question}") — hidden queue exhausted.`,
          );
        }
        return answer;
      },
    },
  };
}

// ── AWS mock clients ──────────────────────────────────────────────────────────

interface SsmCall {
  op: "get" | "put";
  name: string;
  value?: string;
}

interface MockSSM {
  calls: SsmCall[];
  ssm: SSMClient;
  hasKey: (name: string) => boolean;
  addKey: (name: string) => void;
}

function makeMockSSM(existingKeys: string[] = []): MockSSM {
  const params = new Set(existingKeys);
  const calls: SsmCall[] = [];

  const client = {
    async send(cmd: unknown): Promise<unknown> {
      if (cmd instanceof GetParameterCommand) {
        const name = cmd.input.Name as string;
        if (!params.has(name)) {
          const err = new Error("ParameterNotFound") as Error & { name: string };
          err.name = "ParameterNotFound";
          throw err;
        }
        calls.push({ op: "get", name });
        return { Parameter: { Value: "stored-value" } };
      }
      if (cmd instanceof PutParameterCommand) {
        const name = cmd.input.Name as string;
        const value = cmd.input.Value as string;
        params.add(name);
        calls.push({ op: "put", name, value });
        return {};
      }
      return {};
    },
  } as unknown as SSMClient;

  return {
    calls,
    ssm: client,
    hasKey: (name: string) => params.has(name),
    addKey: (name: string) => params.add(name),
  };
}

interface SmCall {
  op: "get" | "put";
  secretId: string;
  value?: string;
}

interface MockSM {
  calls: SmCall[];
  sm: SecretsManagerClient;
  setSecret: (id: string, value: string | null) => void;
  getStored: (id: string) => string | null | undefined;
}

function makeMockSM(secrets: Record<string, string | null> = {}): MockSM {
  const store = new Map<string, string | null>(Object.entries(secrets));
  const calls: SmCall[] = [];

  const client = {
    async send(cmd: unknown): Promise<unknown> {
      if (cmd instanceof GetSecretValueCommand) {
        const secretId = cmd.input.SecretId as string;
        const val = store.get(secretId);
        if (val == null) {
          const err = new Error("ResourceNotFoundException") as Error & { name: string };
          err.name = "ResourceNotFoundException";
          throw err;
        }
        calls.push({ op: "get", secretId });
        return { SecretString: val };
      }
      if (cmd instanceof PutSecretValueCommand) {
        const secretId = cmd.input.SecretId as string;
        const value = cmd.input.SecretString as string;
        store.set(secretId, value);
        calls.push({ op: "put", secretId, value });
        return {};
      }
      return {};
    },
  } as unknown as SecretsManagerClient;

  return {
    calls,
    sm: client,
    setSecret: (id, val) => store.set(id, val),
    getStored: (id) => store.get(id),
  };
}

// ── Fleet YAML builders ───────────────────────────────────────────────────────

/**
 * Minimal valid fleet.yaml with pre-set bot_user_ids + channel IDs.
 * Step 3 and Step 4 automatically skip when all userIds are present.
 */
function makeFleetYaml(opts: {
  fleetName?: string;
  delegationEnabled?: boolean;
  agents?: Array<{
    id: string;
    name?: string;   // optional; defaults to id
    emoji?: string;
    role?: string;
    providers?: string[];
    noProviders?: boolean;
  }>;
} = {}): string {
  const fleetName = opts.fleetName ?? "test-fleet";
  const delegationEnabled = opts.delegationEnabled ?? false;
  const agents = opts.agents ?? [
    { id: "pm-bot", name: "PM Bot", emoji: "🤖", role: "pm", providers: ["anthropic"] },
    { id: "worker-bot", name: "Worker Bot", emoji: "🔧", role: "worker", providers: ["anthropic"] },
  ];

  const delegationYaml = delegationEnabled
    ? `
delegation:
  enabled: true
  table_name: ${fleetName}-tasks
  s3_bucket: ${fleetName}-ledger
  aws_region: us-west-2
  s3_key_template: "v0/projects/{project}/tasks/{date}-{task_id}.md"
`
    : `
delegation:
  enabled: false
  aws_region: us-west-2
`;

  const agentLines = agents
    .map((a, i) => {
      const id = a.id;
      const displayName = a.name ?? id;
      const userId = `U${id.replace(/-/g, "").toUpperCase().padEnd(9, "0")}`.slice(0, 10);
      const channelId = `C${id.replace(/-/g, "").toUpperCase().padEnd(9, "0")}`.slice(0, 10);
      const providersYaml = a.noProviders ? "" : `      providers: [${(a.providers ?? ["anthropic"]).join(", ")}]`;
      return `    - id: ${id}
      name: "${displayName}"
      emoji: "${a.emoji ?? "🤖"}"
      role: ${a.role ?? "worker"}
${providersYaml}
      channels:
        - provider: slack
          account_id: ${id}
          bot_token: "xoxb-placeholder-${i}"
          app_token: "xapp-placeholder-${i}"
          bot_user_id: "${userId}"
          channels:
            - "${channelId}"`;
    })
    .join("\n");

  return `fleet:
  name: ${fleetName}
${delegationYaml}
targets:
  test-host:
    provider: local
    workspace_base: /home/openclaw/.openclaw
agents:
  defaults:
    model: anthropic/claude-sonnet-4-6
    target: test-host
  list:
${agentLines}
`;

}

// ── Test helpers ──────────────────────────────────────────────────────────────

interface TestSetup {
  tmpDir: string;
  fleetFile: string;
  manifestsDir: string;
}

function makeTempFleet(yaml: string): TestSetup {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-onboard-test-"));
  const fleetFile = path.join(tmpDir, "fleet.yaml");
  const manifestsDir = path.join(tmpDir, "docs", "slack-manifests");

  fs.writeFileSync(fleetFile, yaml, "utf-8");

  // Create manifests dir + a dummy manifest so Step 2 skips automatically
  fs.mkdirSync(manifestsDir, { recursive: true });
  fs.writeFileSync(path.join(manifestsDir, "pm-bot.yaml"), "name: pm-bot\n");

  return { tmpDir, fleetFile, manifestsDir };
}

function cleanupTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a standard OnboardDeps suitable for most wizard tests.
 * - fs: real (temp dir with real files)
 * - AWS clients: mocked
 * - prompter: provided by caller
 * - pushFleet / provisionFleet / writeOutputs: no-op mocks
 */
function makeDeps(
  prompter: OnboardDeps["prompter"],
  ssm: SSMClient,
  sm: SecretsManagerClient,
): OnboardDeps {
  return {
    prompter,
    ssm,
    secretsManager: sm,
    fs: {
      existsSync: (p) => fs.existsSync(p),
      writeFileSync: (p, data, enc) => fs.writeFileSync(p, data, enc),
      readdirSync: (p) => fs.readdirSync(p) as string[],
    },
    provisionFleet: async () => { /* no-op */ },
    writeOutputs: (() => ({})) as unknown as OnboardDeps["writeOutputs"],
    pushFleet: (async () => [] as PushFleetResult[]) as unknown as OnboardDeps["pushFleet"],
  };
}

// ── Happy-path tests ──────────────────────────────────────────────────────────

describe("happy path — delegation: false", () => {
  let setup: TestSetup;

  beforeEach(() => {
    setup = makeTempFleet(
      makeFleetYaml({
        fleetName: "hp-fleet",
        delegationEnabled: false,
        agents: [
          { id: "pm-bot", name: "PM Bot", emoji: "🤖", role: "pm", providers: ["anthropic"] },
          { id: "worker-bot", name: "Worker Bot", emoji: "🔧", role: "worker", providers: ["anthropic"] },
        ],
      }),
    );
  });

  afterEach(() => cleanupTempDir(setup.tmpDir));

  test("wizard completes all 12 steps; mocked AWS and prompter drive the run", async () => {
    const fleetName = "hp-fleet";

    // SSM: agent app-ids + PAT already set → step 5 and step 6 skip
    const ssmMock = makeMockSSM([
      `/fleetmind/${fleetName}/agents/pm-bot/github-app/app-id`,
      `/fleetmind/${fleetName}/agents/worker-bot/github-app/app-id`,
      "/fleetmind/shared/github-packages-token",
    ]);

    // SM: real (non-placeholder) slack + anthropic secrets for both agents
    const smMock = makeMockSM({
      [`${fleetName}/agents/pm-bot/slack`]: JSON.stringify({ SLACK_BOT_TOKEN: "xoxb-pm", SLACK_APP_TOKEN: "xapp-pm" }),
      [`${fleetName}/agents/pm-bot/providers/anthropic`]: JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-pm" }),
      [`${fleetName}/agents/worker-bot/slack`]: JSON.stringify({ SLACK_BOT_TOKEN: "xoxb-worker", SLACK_APP_TOKEN: "xapp-worker" }),
      [`${fleetName}/agents/worker-bot/providers/anthropic`]: JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-worker" }),
    });

    // Prompt sequence (see comment above each line):
    const mock = makeMockPrompter(
      [
        true,   // "Start onboarding?"
        // Step 2: skip (manifests exist)
        // Step 3: skip (all user IDs set)
        // Step 4: skip (all user IDs set)
        // Step 5: manifest flow
        false,  // pm-bot: "GitHub App already in SSM. Override?" → no
        false,  // worker-bot: "GitHub App already in SSM. Override?" → no
        // Step 6: skip (PAT already in SSM)
        true,   // "Run fleetmind render?"
        false,  // "Terraform apply complete?" (default false, no-op)
        true,   // "Populate secrets now?"
        // Step 9 agent pm-bot:
        false,  // "Slack tokens already in SM. Override?" → no
        false,  // "anthropic API key already in SM. Override?" → no
        // Step 9 agent worker-bot:
        false,  // "Slack tokens already in SM. Override?" → no
        false,  // "anthropic API key already in SM. Override?" → no
        // Step 10: no new creds to store → skips automatically
        true,   // "Run fleetmind push fleet...?"
      ],
      ["test-org"], // prompt answers (step 5 GitHub owner)
    );

    let provisionCalled = false;
    let writeCalled = false;
    let pushCalled = false;

    const deps: OnboardDeps = {
      prompter: mock.prompter,
      ssm: ssmMock.ssm,
      secretsManager: smMock.sm,
      fs: {
        existsSync: (p) => fs.existsSync(p),
        writeFileSync: (p, data, enc) => fs.writeFileSync(p, data, enc),
        readdirSync: (p) => fs.readdirSync(p) as string[],
      },
      provisionFleet: async () => { provisionCalled = true; },
      writeOutputs: (() => { writeCalled = true; return {}; }) as unknown as OnboardDeps["writeOutputs"],
      pushFleet: (async () => { pushCalled = true; return [] as PushFleetResult[]; }) as unknown as OnboardDeps["pushFleet"],
    };

    await runOnboard(setup.fleetFile, "us-west-2", {}, deps);

    // Verify mocked operations were called
    assert.ok(provisionCalled, "provisionFleet should have been called (step 7)");
    assert.ok(writeCalled, "writeOutputs should have been called (step 7)");
    assert.ok(pushCalled, "pushFleet should have been called (step 11)");

    // Verify no unexpected secrets were written (all existing, all skipped)
    const putCalls = smMock.calls.filter(c => c.op === "put");
    assert.equal(putCalls.length, 0, "no SM writes should occur when all secrets exist and override is refused");
  });
});

describe("happy path — delegation: true", () => {
  let setup: TestSetup;

  beforeEach(() => {
    setup = makeTempFleet(
      makeFleetYaml({
        fleetName: "del-fleet",
        delegationEnabled: true,
        agents: [
          { id: "pm-bot", name: "PM Bot", emoji: "🤖", role: "pm", providers: ["anthropic"] },
          { id: "worker-bot", name: "Worker Bot", emoji: "🔧", role: "worker", providers: ["anthropic"] },
        ],
      }),
    );
  });

  afterEach(() => cleanupTempDir(setup.tmpDir));

  test("wizard completes when delegation is enabled; task-ledger fleet loads cleanly", async () => {
    const fleetName = "del-fleet";
    const ssmMock = makeMockSSM([
      `/fleetmind/${fleetName}/agents/pm-bot/github-app/app-id`,
      `/fleetmind/${fleetName}/agents/worker-bot/github-app/app-id`,
      "/fleetmind/shared/github-packages-token",
    ]);
    const smMock = makeMockSM({
      [`${fleetName}/agents/pm-bot/slack`]: JSON.stringify({ SLACK_BOT_TOKEN: "xoxb-pm" }),
      [`${fleetName}/agents/pm-bot/providers/anthropic`]: JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant" }),
      [`${fleetName}/agents/worker-bot/slack`]: JSON.stringify({ SLACK_BOT_TOKEN: "xoxb-worker" }),
      [`${fleetName}/agents/worker-bot/providers/anthropic`]: JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant" }),
    });

    const mock = makeMockPrompter(
      [true, false, false, true, false, true, false, false, false, false, true],
      ["test-org"],
    );

    let provisionCalled = false;
    const deps: OnboardDeps = {
      ...makeDeps(mock.prompter, ssmMock.ssm, smMock.sm),
      provisionFleet: async () => { provisionCalled = true; },
      writeOutputs: (() => ({})) as unknown as OnboardDeps["writeOutputs"],
      pushFleet: (async () => [] as PushFleetResult[]) as unknown as OnboardDeps["pushFleet"],
    };

    await runOnboard(setup.fleetFile, "us-west-2", {}, deps);
    assert.ok(provisionCalled, "provisionFleet should be called even when delegation is enabled");
  });
});

// ── Step 9 — provider-prompt matrix ──────────────────────────────────────────

describe("step 9 — provider-prompt matrix", () => {
  let tmpDir: string;

  afterEach(() => cleanupTempDir(tmpDir));

  /**
   * Run the wizard through steps 1-8 quickly (accepting defaults), then
   * return a reference to the mock so callers can assert on step 9 calls.
   *
   * Steps 2-4 are skipped automatically (manifests exist, all user IDs set).
   * Step 5: all agents → ssmExists=true → override=false → skip.
   * Step 6: PAT exists → skip.
   * Step 7: confirm("render?") → false → skip.
   * Step 8: terraform ack (no-op).
   * Step 11: confirm("push?") → false → skip.
   */
  async function runStep9Test(opts: {
    agents: Array<{ id: string; name?: string; providers?: string[]; noProviders?: boolean }>;
    smSecrets?: Record<string, string | null>;
    step9ConfirmAnswers: boolean[];
    step9HiddenAnswers: string[];
  }): Promise<{ smMock: MockSM; mockPrompter: MockPrompter }> {
    const fleetName = "s9-fleet";
    const agentDefs = opts.agents.map(a => ({
      id: a.id,
      name: a.name ?? a.id,
      emoji: "🤖",
      role: "worker" as const,
      providers: a.providers,
      noProviders: a.noProviders,
    }));

    const yaml = makeFleetYaml({ fleetName, agents: agentDefs });
    const setup = makeTempFleet(yaml);
    tmpDir = setup.tmpDir;

    const agentIds = opts.agents.map(a => a.id);
    const ssmMock = makeMockSSM([
      ...agentIds.map(id => `/fleetmind/${fleetName}/agents/${id}/github-app/app-id`),
      "/fleetmind/shared/github-packages-token",
    ]);
    const smMock = makeMockSM(opts.smSecrets ?? {});

    // Build prompt queues:
    // - confirm: [start?, step5 override×N, render?, terraform-ack, populate?, ...step9Confirms, push?]
    // - prompt: [ghOwner]
    // - hidden: step9 hidden answers
    const confirmAnswers = [
      true,                                              // "Start onboarding?"
      ...agentIds.map(() => false),                      // step 5: "Override?" × N → no
      false,                                             // "Render?" → skip
      false,                                             // "Terraform?" (ack, no-op)
      true,                                              // "Populate secrets now?"
      ...opts.step9ConfirmAnswers,                       // step 9 specific
      false,                                             // "Push fleet?" → skip
    ];

    const mockPrompter = makeMockPrompter(
      confirmAnswers,
      ["test-org"],               // prompt: gh owner
      opts.step9HiddenAnswers,    // hidden: provider keys (and slack tokens if needed)
    );

    const deps = makeDeps(mockPrompter.prompter, ssmMock.ssm, smMock.sm);

    await runOnboard(setup.fleetFile, "us-west-2", {}, deps);

    return { smMock, mockPrompter };
  }

  test("agent with providers: [openai] — OPENAI_API_KEY prompted, ANTHROPIC not", async () => {
    // Assert that the test agent inherits `model: anthropic/claude-sonnet-4-6` from fleet defaults
    // while declaring `providers: [openai]` — this is the exact model+providers mismatch that
    // motivated issue #210. Making it explicit here ensures future changes don't silently drop it.
    {
      const yaml = makeFleetYaml({ fleetName: "s9-fleet", agents: [{ id: "oai-agent", providers: ["openai"] }] });
      const setup = makeTempFleet(yaml);
      try {
        const fleet = loadFleet(setup.fleetFile);
        const fleetDefault = fleet.agents.defaults.model;
        const agent = fleet.getAgent("oai-agent");
        assert.ok(agent, "oai-agent should exist in fleet");
        assert.equal(
          agent.model ?? fleetDefault,
          "anthropic/claude-sonnet-4-6",
          "test agent should inherit anthropic model from fleet defaults — this is the model+providers mismatch that motivated #210",
        );
        assert.deepEqual(agent.providers, ["openai"], "oai-agent should declare providers: [openai]");
      } finally {
        fs.rmSync(setup.tmpDir, { recursive: true, force: true });
      }
    }

    // Slack secret is missing (null), so 3 hiddenPrompts for slack first, then 1 for openai
    const { mockPrompter, smMock } = await runStep9Test({
      agents: [{ id: "oai-agent", providers: ["openai"] }],
      smSecrets: {}, // all missing → prompts everything
      step9ConfirmAnswers: [],
      step9HiddenAnswers: [
        "xoxb-test",    // slack bot token
        "signing-sec",  // signing secret
        "xapp-test",    // slack app token
        "sk-oai-test",  // openai api key
      ],
    });

    const hiddenCalls = mockPrompter.calls.filter(c => c.type === "hidden");

    // Only openai key should be prompted — NOT anthropic
    const providerPrompts = hiddenCalls.filter(c => c.question.includes("API key"));
    assert.equal(providerPrompts.length, 1, "exactly one provider key should be prompted");
    assert.ok(
      providerPrompts[0]!.question.toLowerCase().includes("openai"),
      `prompt should mention openai, got: "${providerPrompts[0]!.question}"`,
    );
    assert.ok(
      !providerPrompts.some(c => c.question.toLowerCase().includes("anthropic")),
      "anthropic key must NOT be prompted for an openai-only agent",
    );

    // Verify openai secret was written
    const putCalls = smMock.calls.filter(c => c.op === "put");
    assert.ok(
      putCalls.some(c => c.secretId.includes("providers/openai")),
      "openai provider secret should have been written",
    );
    assert.ok(
      !putCalls.some(c => c.secretId.includes("providers/anthropic")),
      "anthropic provider secret should NOT have been written",
    );
  });

  test("agent with providers: [anthropic, openai] — both prompted in declared order", async () => {
    const { mockPrompter, smMock } = await runStep9Test({
      agents: [{ id: "multi-agent", providers: ["anthropic", "openai"] }],
      smSecrets: {},
      step9ConfirmAnswers: [],
      step9HiddenAnswers: [
        "xoxb-test", "signing-sec", "xapp-test", // slack
        "sk-ant-test",  // anthropic — declared first
        "sk-oai-test",  // openai — declared second
      ],
    });

    const providerHidden = mockPrompter.calls
      .filter(c => c.type === "hidden" && c.question.includes("API key"));

    assert.equal(providerHidden.length, 2, "two provider keys should be prompted");
    assert.ok(
      providerHidden[0]!.question.toLowerCase().includes("anthropic"),
      `first provider prompt should be anthropic (declared first), got: "${providerHidden[0]!.question}"`,
    );
    assert.ok(
      providerHidden[1]!.question.toLowerCase().includes("openai"),
      `second provider prompt should be openai (declared second), got: "${providerHidden[1]!.question}"`,
    );

    // Both secrets written
    const putIds = smMock.calls.filter(c => c.op === "put").map(c => c.secretId);
    assert.ok(putIds.some(id => id.includes("providers/anthropic")), "anthropic secret written");
    assert.ok(putIds.some(id => id.includes("providers/openai")), "openai secret written");
  });

  test("existing non-placeholder secret — Override? confirm(false) is shown", async () => {
    const fleetName = "s9-fleet";
    const yaml = makeFleetYaml({
      fleetName,
      agents: [{ id: "override-agent", providers: ["anthropic"] }],
    });
    const setup = makeTempFleet(yaml);
    tmpDir = setup.tmpDir;

    const existingSlack = JSON.stringify({ SLACK_BOT_TOKEN: "xoxb-existing", SLACK_APP_TOKEN: "xapp-existing" });
    const existingAnt = JSON.stringify({ ANTHROPIC_API_KEY: "sk-existing" });
    const ssmMock = makeMockSSM([
      `/fleetmind/${fleetName}/agents/override-agent/github-app/app-id`,
      "/fleetmind/shared/github-packages-token",
    ]);
    const smMock = makeMockSM({
      [`${fleetName}/agents/override-agent/slack`]: existingSlack,
      [`${fleetName}/agents/override-agent/providers/anthropic`]: existingAnt,
    });

    // step 9 will show "Override?" for both slack and anthropic — both answered false
    const mock = makeMockPrompter(
      [
        true,   // Start?
        false,  // step 5 override → no
        false,  // Render? → no
        false,  // Terraform ack
        true,   // Populate? → yes
        false,  // "Slack tokens already in SM. Override?" (defaultYes=false expected)
        false,  // "anthropic API key already in SM. Override?" (defaultYes=false expected)
        false,  // Push? → no
      ],
      ["test-org"],
    );

    const deps = makeDeps(mock.prompter, ssmMock.ssm, smMock.sm);
    await runOnboard(setup.fleetFile, "us-west-2", {}, deps);

    // Find the override confirm calls
    const overrideConfirms = mock.calls.filter(
      c => c.type === "confirm" && c.question.toLowerCase().includes("override"),
    );
    assert.ok(overrideConfirms.length >= 2, "at least 2 Override? confirms should appear");

    // All override prompts should have defaultYes=false (opt-in to override, not opt-out)
    for (const c of overrideConfirms) {
      assert.equal(
        c.defaultYes,
        false,
        `Override? confirm for "${c.question}" should have defaultYes=false`,
      );
    }

    // Nothing written — all overrides refused
    const puts = smMock.calls.filter(c => c.op === "put");
    assert.equal(puts.length, 0, "no secrets should be written when all overrides are declined");
  });

  test("agent missing providers field — wizard errors with descriptive message", async () => {
    const fleetName = "s9-fleet";
    const yaml = makeFleetYaml({
      fleetName,
      agents: [{ id: "no-prov-agent", noProviders: true }],
    });
    const setup = makeTempFleet(yaml);
    tmpDir = setup.tmpDir;

    const ssmMock = makeMockSSM([
      `/fleetmind/${fleetName}/agents/no-prov-agent/github-app/app-id`,
      "/fleetmind/shared/github-packages-token",
    ]);
    const smMock = makeMockSM({});

    // Slack secret is missing → wizard will prompt for slack tokens first, then hit providers → throw
    const mock = makeMockPrompter(
      [
        true,   // Start?
        false,  // step 5 override → no
        false,  // Render? → no
        false,  // Terraform ack
        true,   // Populate? → yes
        // (slack override prompt NOT shown because secret is missing → goes straight to hidden prompts)
      ],
      ["test-org"],
      ["xoxb-test", "signing-sec", "xapp-test"], // slack prompts before the throw
    );

    const deps = makeDeps(mock.prompter, ssmMock.ssm, smMock.sm);

    await assert.rejects(
      async () => runOnboard(setup.fleetFile, "us-west-2", {}, deps),
      (err: Error) => {
        assert.ok(
          err.message.includes("providers") || err.message.includes("no-prov-agent"),
          `Error should mention 'providers' or agent id, got: ${err.message}`,
        );
        return true;
      },
    );
  });
});

// ── Idempotency tests ─────────────────────────────────────────────────────────

describe("idempotency", () => {
  let tmpDir: string;
  afterEach(() => cleanupTempDir(tmpDir));

  test("re-run after step 3 complete — step 3 skips, later steps proceed", async () => {
    // All agents have bot_user_id pre-set → step 3 (Collect Slack Credentials) should skip.
    // Verify: no hiddenPrompt calls for slack tokens in the step-3 credential-collection block.
    const fleetName = "idem-fleet";
    const yaml = makeFleetYaml({
      fleetName,
      agents: [
        { id: "pm-bot", name: "PM Bot", providers: ["anthropic"] },
      ],
    });
    const setup = makeTempFleet(yaml);
    tmpDir = setup.tmpDir;

    const ssmMock = makeMockSSM([
      `/fleetmind/${fleetName}/agents/pm-bot/github-app/app-id`,
      "/fleetmind/shared/github-packages-token",
    ]);
    const smMock = makeMockSM({
      [`${fleetName}/agents/pm-bot/slack`]: JSON.stringify({ SLACK_BOT_TOKEN: "xoxb-real" }),
      [`${fleetName}/agents/pm-bot/providers/anthropic`]: JSON.stringify({ ANTHROPIC_API_KEY: "sk-real" }),
    });

    const mock = makeMockPrompter(
      [true, false, false, false, true, false, false, false],
      ["test-org"],
    );

    const deps = makeDeps(mock.prompter, ssmMock.ssm, smMock.sm);
    await runOnboard(setup.fleetFile, "us-west-2", {}, deps);

    // All hidden calls should be from step 9 (none from step 3 credential collection)
    const hiddenCalls = mock.calls.filter(c => c.type === "hidden");
    assert.equal(
      hiddenCalls.length,
      0,
      "step 3 credential collection should be skipped (all bot_user_ids pre-set); " +
        "step 9 override was refused so no hidden prompts expected",
    );

    // Verify step 3 skip log was printed by checking no slack token prompts
    // (indirect: if step 3 ran, it would need hidden prompts)
    const step3Prompts = mock.calls.filter(
      c => c.type === "hidden" && (c.question.includes("xoxb") || c.question.includes("Bot Token")),
    );
    assert.equal(step3Prompts.length, 0, "no step-3 slack-token prompts should appear");
  });

  test("re-run after step 5 manifest flow — step 5 recognizes already-stored SSM entries", async () => {
    const fleetName = "idem-fleet";
    const agents = [
      { id: "pm-bot", providers: ["anthropic"] },
      { id: "worker-bot", providers: ["anthropic"] },
    ];
    const yaml = makeFleetYaml({ fleetName, agents: agents.map(a => ({ ...a, name: a.id })) });
    const setup = makeTempFleet(yaml);
    tmpDir = setup.tmpDir;

    // Both agents already in SSM (manifest flow was run previously)
    const ssmMock = makeMockSSM([
      `/fleetmind/${fleetName}/agents/pm-bot/github-app/app-id`,
      `/fleetmind/${fleetName}/agents/worker-bot/github-app/app-id`,
      "/fleetmind/shared/github-packages-token",
    ]);
    const smMock = makeMockSM({
      [`${fleetName}/agents/pm-bot/slack`]: JSON.stringify({ SLACK_BOT_TOKEN: "xoxb-pm" }),
      [`${fleetName}/agents/pm-bot/providers/anthropic`]: JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant" }),
      [`${fleetName}/agents/worker-bot/slack`]: JSON.stringify({ SLACK_BOT_TOKEN: "xoxb-worker" }),
      [`${fleetName}/agents/worker-bot/providers/anthropic`]: JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant" }),
    });

    const mock = makeMockPrompter(
      [
        true,   // Start?
        false,  // pm-bot: already in SSM → Override? → no
        false,  // worker-bot: already in SSM → Override? → no
        false,  // Render? → no
        false,  // Terraform ack
        true,   // Populate?
        false,  // pm-bot slack override → no
        false,  // pm-bot anthropic override → no
        false,  // worker-bot slack override → no
        false,  // worker-bot anthropic override → no
        false,  // Push? → no
      ],
      ["test-org"],
    );

    const deps = makeDeps(mock.prompter, ssmMock.ssm, smMock.sm);
    await runOnboard(setup.fleetFile, "us-west-2", {}, deps);

    // Step 5: Override? was shown and answered false for each agent
    const step5Overrides = mock.calls.filter(
      c => c.type === "confirm" && c.question.includes("GitHub App already in SSM"),
    );
    assert.equal(step5Overrides.length, 2, "Override? should be shown once per agent in step 5");
    assert.ok(
      step5Overrides.every(c => c.defaultYes === false),
      "step 5 Override? should default to false (opt-in)",
    );

    // No SSM PUTs for GitHub App (skipped)
    const ssmPuts = ssmMock.calls.filter(c => c.op === "put");
    assert.equal(ssmPuts.length, 0, "no SSM puts should occur when app-ids already exist and override is refused");

    // No SM PUTs (all existing and overrides refused)
    const smPuts = smMock.calls.filter(c => c.op === "put");
    assert.equal(smPuts.length, 0, "no SM puts should occur when all secrets exist and overrides refused");
  });

  test("partial step 9 re-run — only missing providers are re-prompted", async () => {
    // Agent has providers: [anthropic, openai].
    // anthropic secret exists; openai secret is missing.
    // Expected: anthropic → "Override?" (false) → skip; openai → hiddenPrompt.
    const fleetName = "partial-fleet";
    const yaml = makeFleetYaml({
      fleetName,
      agents: [{ id: "multi-bot", name: "Multi Bot", providers: ["anthropic", "openai"] }],
    });
    const setup = makeTempFleet(yaml);
    tmpDir = setup.tmpDir;

    const ssmMock = makeMockSSM([
      `/fleetmind/${fleetName}/agents/multi-bot/github-app/app-id`,
      "/fleetmind/shared/github-packages-token",
    ]);
    const smMock = makeMockSM({
      // slack: missing → will prompt
      // anthropic: exists (real value)
      [`${fleetName}/agents/multi-bot/providers/anthropic`]: JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-existing" }),
      // openai: missing → will prompt
    });

    const mock = makeMockPrompter(
      [
        true,   // Start?
        false,  // step 5 override → no
        false,  // Render? → no
        false,  // Terraform ack
        true,   // Populate?
        // Slack: missing → no override confirm, straight to hidden prompts
        // anthropic: exists → "Override?" → false
        false,  // anthropic override → no
        // openai: missing → hiddenPrompt → no confirm needed
        false,  // Push? → no
      ],
      ["test-org"],
      [
        "xoxb-test", "signing-test", "xapp-test", // slack tokens (missing)
        "sk-oai-new",                              // openai key (missing)
      ],
    );

    const deps = makeDeps(mock.prompter, ssmMock.ssm, smMock.sm);
    await runOnboard(setup.fleetFile, "us-west-2", {}, deps);

    // Anthropic override was shown (already exists)
    const antOverride = mock.calls.find(
      c => c.type === "confirm" && c.question.toLowerCase().includes("anthropic"),
    );
    assert.ok(antOverride, "anthropic override prompt should be shown (key exists)");
    assert.equal(antOverride!.defaultYes, false, "anthropic override should default to false");

    // OpenAI was prompted (missing secret)
    const oaiHidden = mock.calls.find(
      c => c.type === "hidden" && c.question.toLowerCase().includes("openai"),
    );
    assert.ok(oaiHidden, "openai key should be prompted (secret was missing)");

    // OpenAI secret written; anthropic not overwritten
    const puts = smMock.calls.filter(c => c.op === "put");
    assert.ok(puts.some(c => c.secretId.includes("providers/openai")), "openai secret should be written");
    assert.ok(!puts.some(c => c.secretId.includes("providers/anthropic")), "anthropic should NOT be overwritten");
  });
});

// ── Fallback tests ────────────────────────────────────────────────────────────

describe("fallback", () => {
  let tmpDir: string;
  afterEach(() => cleanupTempDir(tmpDir));

  test("--legacy-github-apps flag: owner prompt skipped; App ID + PEM prompts fired", async () => {
    const fleetName = "legacy-fleet";
    const yaml = makeFleetYaml({
      fleetName,
      agents: [{ id: "bot-one", name: "Bot One", providers: ["anthropic"] }],
    });
    const setup = makeTempFleet(yaml);
    tmpDir = setup.tmpDir;

    const ssmMock = makeMockSSM([
      "/fleetmind/shared/github-packages-token",
      // Note: app-id NOT pre-set → step 5 will prompt
    ]);
    const smMock = makeMockSM({
      [`${fleetName}/agents/bot-one/slack`]: JSON.stringify({ SLACK_BOT_TOKEN: "xoxb-real" }),
      [`${fleetName}/agents/bot-one/providers/anthropic`]: JSON.stringify({ ANTHROPIC_API_KEY: "sk-real" }),
    });

    // With legacy mode: NO "GitHub owner" prompt; instead per-agent App ID + Installation ID + PEM path
    const mock = makeMockPrompter(
      [
        true,   // Start?
        // Step 5: legacy mode — no manifest owner prompt
        // bot-one app-id NOT in SSM → no "Override?" shown → go to legacy prompts
        false,  // Render? → no
        false,  // Terraform ack
        true,   // Populate?
        false,  // Slack override → no (existing secret)
        false,  // anthropic override → no
        false,  // Step 10: "Store 1 legacy-flow cred set?" → no
        false,  // Push? → no
      ],
      [
        // prompt() answers in order:
        "12345",          // App ID
        "67890",          // Installation ID
        "/tmp/fake.pem",  // PEM file path
      ],
    );

    const deps = makeDeps(mock.prompter, ssmMock.ssm, smMock.sm);
    await runOnboard(setup.fleetFile, "us-west-2", { legacyGithubApps: true }, deps);

    // Verify no "GitHub owner" prompt was shown
    const ownerPrompt = mock.calls.find(
      c => c.type === "prompt" && c.question.toLowerCase().includes("owner"),
    );
    assert.equal(ownerPrompt, undefined, "GitHub owner prompt must NOT appear in legacy mode");

    // Verify App ID + Installation ID + PEM prompts were shown
    const promptCalls = mock.calls.filter(c => c.type === "prompt");
    assert.ok(
      promptCalls.some(c => c.question.toLowerCase().includes("app id")),
      "App ID prompt should appear in legacy mode",
    );
    assert.ok(
      promptCalls.some(c => c.question.toLowerCase().includes("installation id")),
      "Installation ID prompt should appear in legacy mode",
    );
    assert.ok(
      promptCalls.some(c => c.question.toLowerCase().includes("pem")),
      "PEM file path prompt should appear in legacy mode",
    );
  });

  test("empty GitHub owner falls back to legacy manual flow", async () => {
    // If the operator provides an empty owner in the manifest flow prompt,
    // the wizard should warn and fall back to legacy mode (prompting App ID etc.)
    const fleetName = "fallback-fleet";
    const yaml = makeFleetYaml({
      fleetName,
      agents: [{ id: "fb-agent", name: "FB Agent", providers: ["anthropic"] }],
    });
    const setup = makeTempFleet(yaml);
    tmpDir = setup.tmpDir;

    const ssmMock = makeMockSSM([
      "/fleetmind/shared/github-packages-token",
      // app-id NOT pre-set
    ]);
    const smMock = makeMockSM({
      [`${fleetName}/agents/fb-agent/slack`]: JSON.stringify({ SLACK_BOT_TOKEN: "xoxb-real" }),
      [`${fleetName}/agents/fb-agent/providers/anthropic`]: JSON.stringify({ ANTHROPIC_API_KEY: "sk-real" }),
    });

    const mock = makeMockPrompter(
      [
        true,   // Start?
        // Step 5: manifest flow, but owner is empty → fallback → legacy prompts for agent
        // No "Override?" confirm needed here (not already in SSM, goes to legacy prompts)
        false,  // Render? → no
        false,  // Terraform ack
        true,   // Populate?
        false,  // Slack override (existing) → no
        false,  // anthropic override (existing) → no
        false,  // Step 10: store creds? → no
        false,  // Push? → no
      ],
      [
        "",            // GitHub owner → empty string → triggers fallback
        "11111",       // App ID (legacy fallback)
        "22222",       // Installation ID
        "/tmp/x.pem",  // PEM path
      ],
    );

    const deps = makeDeps(mock.prompter, ssmMock.ssm, smMock.sm);
    await runOnboard(setup.fleetFile, "us-west-2", {}, deps);

    // After the empty owner, legacy prompts should fire
    const promptCalls = mock.calls.filter(c => c.type === "prompt");
    const appIdPrompt = promptCalls.find(c => c.question.toLowerCase().includes("app id"));
    assert.ok(appIdPrompt, "App ID prompt should appear after fallback from empty owner");
  });
});

// ── createDefaultDeps smoke test ──────────────────────────────────────────────

describe("createDefaultDeps", () => {
  test("factory returns an object satisfying the OnboardDeps interface shape", async () => {
    const { createDefaultDeps } = await import("../cli/commands/onboard.js");
    const deps = createDefaultDeps("us-west-2");

    assert.ok(deps.prompter, "prompter should be set");
    assert.ok(typeof deps.prompter.prompt === "function");
    assert.ok(typeof deps.prompter.hiddenPrompt === "function");
    assert.ok(typeof deps.prompter.confirm === "function");
    assert.ok(deps.secretsManager, "secretsManager should be set");
    assert.ok(deps.ssm, "ssm should be set");
    assert.ok(deps.fs, "fs should be set");
    assert.ok(typeof deps.fs.existsSync === "function");
    assert.ok(typeof deps.fs.writeFileSync === "function");
    assert.ok(typeof deps.fs.readdirSync === "function");
    assert.ok(typeof deps.pushFleet === "function");
    assert.ok(typeof deps.provisionFleet === "function");
    assert.ok(typeof deps.writeOutputs === "function");
  });
});
