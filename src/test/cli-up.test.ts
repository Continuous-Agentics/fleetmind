/**
 * Tests for `fleetmind up` — the local single-gateway bring-up.
 *
 * Covers resolveLocalTarget's guards and an end-to-end --no-daemon run that
 * stages config + secrets + workspaces to a temp OpenClaw home, asserting the
 * key invariants: secrets stay as ${VAR} in openclaw.json (values only in a
 * 0600 .env), and each agent's workspace is placed under workspace_base.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, describe, beforeEach, afterEach } from "node:test";

import { FleetSchema } from "../config/schema.js";
import { normalizeFleet } from "../core/model.js";
import { resolveLocalTarget, runUp } from "../cli/commands/up.js";

function fleetWith(targets: Record<string, unknown>, defaultsTarget?: string) {
  return normalizeFleet(
    FleetSchema.parse({
      fleet: { name: "demo" },
      targets,
      agents: {
        defaults: { ...(defaultsTarget ? { target: defaultsTarget } : {}) },
        list: [{ id: "solo", name: "Solo", ...(defaultsTarget ? {} : {}) }],
      },
    })
  );
}

const localTarget = { provider: "local", os: "macos", service_manager: "launchd", workspace_base: "/tmp/x" };
const awsTarget = { provider: "aws-ssm", os: "linux", service_manager: "systemd", workspace_base: "/opt/x", aws: { region: "us-west-2" } };

describe("resolveLocalTarget", () => {
  test("returns the single local target", () => {
    const t = resolveLocalTarget(fleetWith({ box: localTarget }, "box"));
    assert.equal(t.id, "box");
    assert.equal(t.provider, "local");
  });

  test("throws when there is no local target", () => {
    assert.throws(() => resolveLocalTarget(fleetWith({ ec2: awsTarget }, "ec2")), /needs a target with `provider: local`/);
  });

  test("throws when there are multiple local targets", () => {
    const fleet = fleetWith({ a: localTarget, b: localTarget }, "a");
    assert.throws(() => resolveLocalTarget(fleet), /brings up a single local host/);
  });
});

describe("runUp --no-daemon (staging)", () => {
  let tmp: string;
  let saved: Record<string, string | undefined>;
  const vars = ["SOLO_BOT_TOKEN", "SOLO_APP_TOKEN", "ANTHROPIC_API_KEY"];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fm-up-test-"));
    saved = {};
    for (const v of vars) { saved[v] = process.env[v]; process.env[v] = `val-${v}`; }
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const v of vars) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; }
  });

  test("stages openclaw.json (placeholders intact), 0600 .env, and the workspace", async () => {
    const ws = path.join(tmp, "ws");
    const ochome = path.join(tmp, "ochome");
    const fleetPath = path.join(tmp, "fleet.yaml");
    fs.writeFileSync(fleetPath, `
fleet:
  name: local-demo
targets:
  box:
    provider: local
    os: macos
    service_manager: launchd
    workspace_base: ${ws}
agents:
  defaults:
    target: box
    model: anthropic/claude-sonnet-4-6
  list:
    - id: solo
      name: Solo
      orchestrator: true
      channels:
        - provider: slack
          account_id: solo
          bot_token: "\${SOLO_BOT_TOKEN}"
          app_token: "\${SOLO_APP_TOKEN}"
      skills: []
`.trimStart());

    await runUp({ fleet: fleetPath, dryRun: false, daemon: false, openclawHome: ochome });

    // openclaw.json: workspace points under workspace_base; secrets stay as ${VAR}.
    const cfg = JSON.parse(fs.readFileSync(path.join(ochome, "openclaw.json"), "utf-8"));
    assert.equal(cfg.agents.list[0].workspace, path.join(ws, "solo"));
    assert.equal(cfg.channels.slack.accounts.solo.botToken, "${SOLO_BOT_TOKEN}");

    // .env: 0600, values resolved (incl. the derived ANTHROPIC_API_KEY).
    const envPath = path.join(ochome, ".env");
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
    const envBody = fs.readFileSync(envPath, "utf-8");
    assert.match(envBody, /SOLO_BOT_TOKEN=val-SOLO_BOT_TOKEN/);
    assert.match(envBody, /ANTHROPIC_API_KEY=val-ANTHROPIC_API_KEY/);

    // workspace placed under workspace_base/<agent>.
    assert.ok(fs.existsSync(path.join(ws, "solo", "SOUL.md")));
  });
});
