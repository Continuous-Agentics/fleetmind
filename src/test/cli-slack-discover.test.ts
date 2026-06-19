/**
 * Unit tests for `fleetmind slack discover`.
 *
 * Uses dependency injection (smClient, httpFn, writeFn) to avoid live AWS
 * and Slack calls — same pattern as populate.ts / github-app.ts.
 *
 * Covers:
 *   - Happy path: 2 agents, both unset → both discovered and written
 *   - Skip existing: agent with bot_user_id already set is skipped
 *   - --force overrides: existing bot_user_id replaced when --force passed
 *   - --dry-run: no file write, output describes proposed changes
 *   - auth.test failure (invalid_auth): warning logged, agent skipped, others proceed
 *   - Missing SM secret: warning logged, agent skipped
 *   - --agent filter: only listed agents processed
 *   - Comment preservation: fleet.yaml with comments → after write, comments preserved
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, describe, beforeEach, afterEach } from "node:test";

import {
  discoverSlackBotUserIds,
  writeFleetYaml,
  writeSlackChannelIds,
  type DiscoverOptions,
  type SmSendable,
  type HttpFn,
  type WriteFn,
} from "../cli/commands/slack.js";
import { parse as parseYaml } from "yaml";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// ── Test fixtures ─────────────────────────────────────────────────────────────

let tmpDir: string;
let fleetPath: string;

const FLEET_YAML_BASIC = `
# fleet.yaml — test fleet
fleet:
  name: test-fleet

agents:
  list:
    - id: alpha
      name: Alpha
      channels:
        - provider: slack
          bot_token: "\${ALPHA_BOT_TOKEN}"
    - id: beta
      name: Beta
      channels:
        - provider: slack
          bot_token: "\${BETA_BOT_TOKEN}"
`.trimStart();

const FLEET_YAML_ONE_SET = `
fleet:
  name: test-fleet

agents:
  list:
    - id: alpha
      name: Alpha
      channels:
        - provider: slack
          bot_user_id: "UALPHAEXST"
          bot_token: "\${ALPHA_BOT_TOKEN}"
    - id: beta
      name: Beta
      channels:
        - provider: slack
          bot_token: "\${BETA_BOT_TOKEN}"
`.trimStart();

const FLEET_YAML_WITH_COMMENTS = `
fleet:
  name: test-fleet

agents:
  list:
    - id: forge
      name: Forge
      channels:
        - provider: slack
          # TODO: run \`fleetmind slack discover --agent forge\` to populate
          # bot_user_id: "U_FORGE"
          bot_token: "\${FORGE_BOT_TOKEN}"
`.trimStart();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-slack-discover-"));
  fleetPath = path.join(tmpDir, "fleet.yaml");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Mock factories ────────────────────────────────────────────────────────────

function makeSmClient(
  secrets: Record<string, string>
): SmSendable & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async send(cmd: GetSecretValueCommand) {
      const secretId = (cmd as unknown as { input: { SecretId: string } }).input.SecretId;
      calls.push(secretId);
      if (secretId in secrets) {
        return { SecretString: secrets[secretId] };
      }
      // Simulate AWS ResourceNotFoundException
      const err = new Error(`Secrets Manager can't find the specified secret.`);
      (err as NodeJS.ErrnoException).name = "ResourceNotFoundException";
      throw err;
    },
  };
}

function makeHttpFn(
  responses: Record<string, { ok: boolean; user_id?: string; error?: string }>
): HttpFn & { calls: string[] } {
  const calls: string[] = [];
  return Object.assign(
    async (url: string, opts: { method: string; headers: Record<string, string> }) => {
      const token = opts.headers["Authorization"]?.replace("Bearer ", "") ?? "";
      calls.push(token);
      const resp = responses[token] ?? { ok: false, error: "not_configured" };
      return {
        ok: true,
        json: async () => resp,
      };
    },
    { calls }
  );
}

function makeWriteFn(): WriteFn & { calls: Array<{ path: string; content: string }> } {
  const calls: Array<{ path: string; content: string }> = [];
  return Object.assign(
    (filePath: string, content: string) => {
      calls.push({ path: filePath, content });
    },
    { calls }
  );
}

// ── Helper: build slack secret JSON ──────────────────────────────────────────

function slackSecret(botToken: string): string {
  return JSON.stringify({ SLACK_BOT_TOKEN: botToken });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("discoverSlackBotUserIds — happy path (2 agents, both unset)", () => {
  test("discovers both agents and writes fleet.yaml", async () => {
    fs.writeFileSync(fleetPath, FLEET_YAML_BASIC);

    const sm = makeSmClient({
      "test-fleet/agents/alpha/slack": slackSecret("xoxb-alpha"),
      "test-fleet/agents/beta/slack": slackSecret("xoxb-beta"),
    });
    const http = makeHttpFn({
      "xoxb-alpha": { ok: true, user_id: "U_ALPHA" },
      "xoxb-beta": { ok: true, user_id: "U_BETA" },
    });
    const writeFn = makeWriteFn();

    const result = await discoverSlackBotUserIds({
      fleet: fleetPath,
      region: "us-west-2",
      dryRun: false,
      force: false,
      smClient: sm,
      httpFn: http,
      writeFn,
    });

    assert.equal(result.discoveredCount, 2, "should discover both agents");
    assert.equal(result.skippedCount, 0);
    assert.equal(result.failedCount, 0);

    const alpha = result.agents.find((a) => a.agentId === "alpha");
    const beta = result.agents.find((a) => a.agentId === "beta");
    assert.ok(alpha, "alpha result should exist");
    assert.equal(alpha!.status, "discovered");
    assert.equal(alpha!.botUserId, "U_ALPHA");
    assert.ok(beta, "beta result should exist");
    assert.equal(beta!.status, "discovered");
    assert.equal(beta!.botUserId, "U_BETA");

    // writeFn should have been called once with the fleet path
    assert.equal(writeFn.calls.length, 1, "should write fleet.yaml once");
    assert.equal(writeFn.calls[0]!.path, fleetPath);

    // Written YAML should contain both user_ids
    const written = writeFn.calls[0]!.content;
    assert.ok(written.includes("U_ALPHA"), "written YAML should contain U_ALPHA");
    assert.ok(written.includes("U_BETA"), "written YAML should contain U_BETA");
  });
});

describe("discoverSlackBotUserIds — skip existing", () => {
  test("skips agent with existing bot_user_id, discovers the other", async () => {
    fs.writeFileSync(fleetPath, FLEET_YAML_ONE_SET);

    const sm = makeSmClient({
      "test-fleet/agents/beta/slack": slackSecret("xoxb-beta"),
    });
    const http = makeHttpFn({
      "xoxb-beta": { ok: true, user_id: "U_BETA_NEW" },
    });
    const writeFn = makeWriteFn();

    const result = await discoverSlackBotUserIds({
      fleet: fleetPath,
      region: "us-west-2",
      dryRun: false,
      force: false,
      smClient: sm,
      httpFn: http,
      writeFn,
    });

    assert.equal(result.discoveredCount, 1, "should discover only beta");
    assert.equal(result.skippedCount, 1, "should skip alpha (already set)");

    const alpha = result.agents.find((a) => a.agentId === "alpha");
    assert.equal(alpha!.status, "skipped");

    const beta = result.agents.find((a) => a.agentId === "beta");
    assert.equal(beta!.status, "discovered");
    assert.equal(beta!.botUserId, "U_BETA_NEW");

    // SM should NOT have been called for alpha
    assert.ok(
      !sm.calls.some((c) => c.includes("alpha")),
      "should not fetch alpha secret when already set"
    );
  });
});

describe("discoverSlackBotUserIds — --force overrides", () => {
  test("overwrites existing bot_user_id when --force passed", async () => {
    fs.writeFileSync(fleetPath, FLEET_YAML_ONE_SET);

    const sm = makeSmClient({
      "test-fleet/agents/alpha/slack": slackSecret("xoxb-alpha-new"),
      "test-fleet/agents/beta/slack": slackSecret("xoxb-beta"),
    });
    const http = makeHttpFn({
      "xoxb-alpha-new": { ok: true, user_id: "U_ALPHA_NEW" },
      "xoxb-beta": { ok: true, user_id: "U_BETA" },
    });
    const writeFn = makeWriteFn();

    const result = await discoverSlackBotUserIds({
      fleet: fleetPath,
      region: "us-west-2",
      dryRun: false,
      force: true, // <-- force
      smClient: sm,
      httpFn: http,
      writeFn,
    });

    assert.equal(result.discoveredCount, 2, "should discover both agents with --force");
    assert.equal(result.skippedCount, 0);

    const alpha = result.agents.find((a) => a.agentId === "alpha");
    assert.equal(alpha!.status, "discovered");
    assert.equal(alpha!.botUserId, "U_ALPHA_NEW");
  });
});

describe("discoverSlackBotUserIds — --dry-run", () => {
  test("does not call writeFn in dry-run mode", async () => {
    fs.writeFileSync(fleetPath, FLEET_YAML_BASIC);

    const sm = makeSmClient({
      "test-fleet/agents/alpha/slack": slackSecret("xoxb-alpha"),
      "test-fleet/agents/beta/slack": slackSecret("xoxb-beta"),
    });
    const http = makeHttpFn({
      "xoxb-alpha": { ok: true, user_id: "U_ALPHA" },
      "xoxb-beta": { ok: true, user_id: "U_BETA" },
    });
    const writeFn = makeWriteFn();

    const result = await discoverSlackBotUserIds({
      fleet: fleetPath,
      region: "us-west-2",
      dryRun: true, // <-- dry-run
      force: false,
      smClient: sm,
      httpFn: http,
      writeFn,
    });

    assert.equal(result.discoveredCount, 2, "should report discovered count");
    assert.equal(writeFn.calls.length, 0, "should NOT write fleet.yaml in dry-run");
  });
});

describe("discoverSlackBotUserIds — auth.test failure", () => {
  test("logs warning and skips failed agent, continues with others", async () => {
    fs.writeFileSync(fleetPath, FLEET_YAML_BASIC);

    const sm = makeSmClient({
      "test-fleet/agents/alpha/slack": slackSecret("xoxb-alpha-bad"),
      "test-fleet/agents/beta/slack": slackSecret("xoxb-beta"),
    });
    const http = makeHttpFn({
      "xoxb-alpha-bad": { ok: false, error: "invalid_auth" },
      "xoxb-beta": { ok: true, user_id: "U_BETA" },
    });
    const writeFn = makeWriteFn();

    const result = await discoverSlackBotUserIds({
      fleet: fleetPath,
      region: "us-west-2",
      dryRun: false,
      force: false,
      smClient: sm,
      httpFn: http,
      writeFn,
    });

    assert.equal(result.discoveredCount, 1, "should discover only beta");
    assert.equal(result.failedCount, 1, "alpha should have failed");

    const alpha = result.agents.find((a) => a.agentId === "alpha");
    assert.equal(alpha!.status, "failed");
    assert.ok(alpha!.reason?.includes("invalid_auth"), "reason should mention invalid_auth");

    const beta = result.agents.find((a) => a.agentId === "beta");
    assert.equal(beta!.status, "discovered");
    assert.equal(beta!.botUserId, "U_BETA");

    // Should still write fleet.yaml for beta
    assert.equal(writeFn.calls.length, 1);
    assert.ok(writeFn.calls[0]!.content.includes("U_BETA"));
  });
});

describe("discoverSlackBotUserIds — missing SM secret", () => {
  test("logs warning and skips agent when secret not found", async () => {
    fs.writeFileSync(fleetPath, FLEET_YAML_BASIC);

    // Only beta has a secret
    const sm = makeSmClient({
      "test-fleet/agents/beta/slack": slackSecret("xoxb-beta"),
    });
    const http = makeHttpFn({
      "xoxb-beta": { ok: true, user_id: "U_BETA" },
    });
    const writeFn = makeWriteFn();

    const result = await discoverSlackBotUserIds({
      fleet: fleetPath,
      region: "us-west-2",
      dryRun: false,
      force: false,
      smClient: sm,
      httpFn: http,
      writeFn,
    });

    assert.equal(result.discoveredCount, 1);
    assert.equal(result.failedCount, 1, "alpha should fail due to missing secret");

    const alpha = result.agents.find((a) => a.agentId === "alpha");
    assert.equal(alpha!.status, "failed");
    assert.ok(alpha!.reason?.toLowerCase().includes("secret"), "reason should mention secret");
  });
});

describe("discoverSlackBotUserIds — --agent filter", () => {
  test("only processes the listed agents", async () => {
    fs.writeFileSync(fleetPath, FLEET_YAML_BASIC);

    const sm = makeSmClient({
      "test-fleet/agents/alpha/slack": slackSecret("xoxb-alpha"),
      "test-fleet/agents/beta/slack": slackSecret("xoxb-beta"),
    });
    const http = makeHttpFn({
      "xoxb-alpha": { ok: true, user_id: "U_ALPHA" },
      "xoxb-beta": { ok: true, user_id: "U_BETA" },
    });
    const writeFn = makeWriteFn();

    const result = await discoverSlackBotUserIds({
      fleet: fleetPath,
      region: "us-west-2",
      dryRun: false,
      force: false,
      agent: ["beta"], // <-- filter to beta only
      smClient: sm,
      httpFn: http,
      writeFn,
    });

    assert.equal(result.agents.length, 1, "should only process beta");
    assert.equal(result.agents[0]!.agentId, "beta");
    assert.equal(result.agents[0]!.status, "discovered");

    // SM should NOT be called for alpha
    assert.ok(
      !sm.calls.some((c) => c.includes("alpha")),
      "should not fetch alpha secret when filtered out"
    );
  });
});

describe("writeFleetYaml — comment preservation", () => {
  test("preserves comments and non-bot_user_id fields after write", () => {
    fs.writeFileSync(fleetPath, FLEET_YAML_WITH_COMMENTS);

    const updates = new Map([["forge", "U_FORGE_REAL"]]);
    const writtenContents: string[] = [];
    const writeFn: WriteFn = (_p, content) => writtenContents.push(content);

    writeFleetYaml(fleetPath, updates, writeFn);

    assert.equal(writtenContents.length, 1, "should call writeFn once");
    const written = writtenContents[0]!;

    // bot_user_id should be set
    assert.ok(written.includes("U_FORGE_REAL"), "should include the new bot_user_id");

    // Comments should be preserved
    assert.ok(
      written.includes("TODO: run"),
      "should preserve TODO comment"
    );

    // bot_token should still be present
    assert.ok(written.includes("FORGE_BOT_TOKEN"), "should preserve bot_token field");
  });

  test("preserves fleet-level comments and structure", () => {
    const yamlWithHeader = `
# fleet.yaml — minimal viable test fleet for dogfood (624905204775)
# 1 PM (Conductor) + 1 worker (Forge, backend specialty)
fleet:
  name: myfleet

agents:
  list:
    - id: agentx
      name: AgentX
      channels:
        - provider: slack
          bot_token: "\${AGENTX_BOT_TOKEN}"
`.trimStart();

    const p = path.join(tmpDir, "fleet2.yaml");
    fs.writeFileSync(p, yamlWithHeader);

    const updates = new Map([["agentx", "U_AGENTX"]]);
    const writtenContents: string[] = [];
    const writeFn: WriteFn = (_fp, content) => writtenContents.push(content);

    writeFleetYaml(p, updates, writeFn);

    const written = writtenContents[0]!;
    assert.ok(written.includes("1 PM (Conductor)"), "should preserve file header comment");
    assert.ok(written.includes("U_AGENTX"), "should contain the new bot_user_id");
  });
});

describe("writeSlackChannelIds — v2 nested channels writeback", () => {
  // Two agents, each with a v2 nested slack channel entry whose `channels:`
  // (the channel-ID list) is empty — the shape `fleetmind init` scaffolds.
  const FLEET_V2 = `
# fleet.yaml — channel writeback fixture
fleet:
  name: test-fleet

agents:
  list:
    - id: conductor
      name: Conductor
      channels:
        - provider: slack
          account_id: conductor
          bot_token: "\${CONDUCTOR_BOT_TOKEN}"  # keep me
          channels: []
    - id: forge
      name: Forge
      channels:
        - provider: slack
          account_id: forge
          bot_token: "\${FORGE_BOT_TOKEN}"
`.trimStart();

  test("writes IDs into the nested slack channels list, not the agent channels seq", () => {
    const p = path.join(tmpDir, "fleet-v2.yaml");
    fs.writeFileSync(p, FLEET_V2);

    const written: string[] = [];
    const writeFn: WriteFn = (_p, content) => written.push(content);

    writeSlackChannelIds(p, new Map([["conductor", ["C123", "C456"]]]), writeFn);

    assert.equal(written.length, 1);
    const out = written[0];
    const doc = parseYaml(out);
    const conductor = doc.agents.list.find((a: { id: string }) => a.id === "conductor");
    const slack = conductor.channels.find((c: { provider: string }) => c.provider === "slack");
    // The channel IDs landed in the nested slack `channels` list…
    assert.deepEqual(slack.channels, ["C123", "C456"]);
    // …and the agent still has exactly one channel entry (the slack one), i.e.
    // we did NOT clobber the agent-level channels sequence.
    assert.equal(conductor.channels.length, 1);
    // Comment + token reference preserved.
    assert.ok(out.includes("# keep me"));
    assert.ok(out.includes("CONDUCTOR_BOT_TOKEN"));
  });

  test("skips agents not in the update map and empty ID lists", () => {
    const p = path.join(tmpDir, "fleet-v2b.yaml");
    fs.writeFileSync(p, FLEET_V2);

    const written: string[] = [];
    const writeFn: WriteFn = (_p, content) => written.push(content);

    // forge gets an empty list (skip); conductor gets real IDs.
    writeSlackChannelIds(
      p,
      new Map([["conductor", ["C999"]], ["forge", []]]),
      writeFn
    );

    const doc = parseYaml(written[0]);
    const forge = doc.agents.list.find((a: { id: string }) => a.id === "forge");
    const forgeSlack = forge.channels.find((c: { provider: string }) => c.provider === "slack");
    // forge had no `channels:` key and an empty update → unchanged (undefined).
    assert.equal(forgeSlack.channels, undefined);
  });
});
