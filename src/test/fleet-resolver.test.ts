/**
 * Tests for resolveFleetSource() and resolveAndLoadFleet().
 *
 * Covers all 5 resolution cases from the spec:
 *  1. --fleet <path.yaml> + file exists  → load as file
 *  2. --fleet <name>       (no .yaml)    → build minimal fleet from name
 *  3. No --fleet + /etc/fleetmind/agent.env exists → use FLEET_NAME
 *  4. No --fleet + no agent.env + fleet.yaml in CWD → load CWD fleet.yaml
 *  5. None of the above → throw
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFleetSource, buildMinimalFleet, resolveAndLoadFleet } from "../config/loader.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Write a minimal valid fleet.yaml to the given path */
function writeMinimalFleetYaml(filePath: string, name = "test-fleet"): void {
  const yaml = `
fleet:
  name: ${name}
agents:
  list: []
delegation:
  enabled: true
  table_name: ${name}-tasks
  s3_bucket: ${name}-ledger
  aws_region: us-west-2
`.trim();
  fs.writeFileSync(filePath, yaml, "utf-8");
}

// ── Case 1: explicit .yaml path ───────────────────────────────────────────────

describe("resolveFleetSource — case 1: explicit yaml file path", () => {
  let tmpDir: string;
  let fleetPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-resolver-"));
    fleetPath = path.join(tmpDir, "fleet.yaml");
    writeMinimalFleetYaml(fleetPath, "file-fleet");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns kind=file with absolute path when .yaml flag given and file exists", () => {
    const result = resolveFleetSource(fleetPath);
    assert.equal(result.kind, "file");
    assert.equal(result.kind === "file" && result.path, path.resolve(fleetPath));
  });

  it("still returns kind=file even if file does not exist (loadFleet will throw)", () => {
    const missing = path.join(tmpDir, "nonexistent.yaml");
    const result = resolveFleetSource(missing);
    assert.equal(result.kind, "file");
  });

  it(".yml extension also treated as file", () => {
    const ymlPath = path.join(tmpDir, "fleet.yml");
    writeMinimalFleetYaml(ymlPath, "yml-fleet");
    const result = resolveFleetSource(ymlPath);
    assert.equal(result.kind, "file");
  });
});

// ── Case 2: explicit fleet name (no .yaml extension) ─────────────────────────

describe("resolveFleetSource — case 2: fleet name flag", () => {
  it("returns kind=name when flag has no .yaml extension", () => {
    const result = resolveFleetSource("my-fleet");
    assert.equal(result.kind, "name");
    assert.equal(result.kind === "name" && result.name, "my-fleet");
  });

  it("returns kind=name for names with hyphens and numbers", () => {
    const result = resolveFleetSource("prod-fleet-2");
    assert.equal(result.kind, "name");
  });
});

// ── Case 3: /etc/fleetmind/agent.env ─────────────────────────────────────────

describe("resolveFleetSource — case 3: /etc/fleetmind/agent.env", () => {
  const agentEnvPath = "/etc/fleetmind/agent.env";
  const agentEnvDir = "/etc/fleetmind";

  // Skip if we can't write to /etc (CI environments usually can't)
  const canWrite = (() => {
    try {
      fs.accessSync("/etc", fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  })();

  it("reads FLEET_NAME from agent.env when no --fleet flag", { skip: !canWrite }, () => {
    fs.mkdirSync(agentEnvDir, { recursive: true });
    fs.writeFileSync(agentEnvPath, "FLEET_NAME=bot-fleet\nAGENT_ID=agent-1\n", "utf-8");
    try {
      const result = resolveFleetSource(undefined);
      assert.equal(result.kind, "name");
      assert.equal(result.kind === "name" && result.name, "bot-fleet");
    } finally {
      fs.rmSync(agentEnvPath, { force: true });
    }
  });

  it("throws if agent.env exists but has no FLEET_NAME", { skip: !canWrite }, () => {
    fs.mkdirSync(agentEnvDir, { recursive: true });
    fs.writeFileSync(agentEnvPath, "AGENT_ID=agent-1\n", "utf-8");
    try {
      assert.throws(
        () => resolveFleetSource(undefined),
        /FLEET_NAME/
      );
    } finally {
      fs.rmSync(agentEnvPath, { force: true });
    }
  });
});

// ── Case 4: fleet.yaml in CWD ────────────────────────────────────────────────

describe("resolveFleetSource — case 4: fleet.yaml in CWD", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-cwd-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads fleet.yaml from CWD when no flag given and no agent.env", () => {
    // Ensure agent.env doesn't exist on this test host OR skip case 3 precondition
    const agentEnvExists = fs.existsSync("/etc/fleetmind/agent.env");
    if (agentEnvExists) return; // Skip — case 3 takes precedence

    writeMinimalFleetYaml(path.join(tmpDir, "fleet.yaml"), "cwd-fleet");
    const result = resolveFleetSource(undefined);
    assert.equal(result.kind, "file");
    assert.ok((result.kind === "file" ? result.path : "").includes(tmpDir));
  });
});

// ── Case 5: nothing found → error ────────────────────────────────────────────

describe("resolveFleetSource — case 5: no resolution possible", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-empty-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws a descriptive error when no resolution path exists", () => {
    const agentEnvExists = fs.existsSync("/etc/fleetmind/agent.env");
    if (agentEnvExists) return; // Skip — agent.env would resolve first

    assert.throws(
      () => resolveFleetSource(undefined),
      /couldn't resolve fleet/i
    );
  });
});

// ── buildMinimalFleet ─────────────────────────────────────────────────────────

describe("buildMinimalFleet", () => {
  it("builds a valid Fleet from a name with correct naming conventions", () => {
    const fleet = buildMinimalFleet("alpha-fleet");
    assert.equal(fleet.fleet.name, "alpha-fleet");
    assert.equal(fleet.delegation?.table_name, "alpha-fleet-tasks");
    assert.equal(fleet.delegation?.s3_bucket, "alpha-fleet-ledger");
    assert.equal(fleet.delegation?.enabled, true);
  });

  it("uses AWS_REGION env var when set", () => {
    const prev = process.env["AWS_REGION"];
    process.env["AWS_REGION"] = "eu-west-1";
    try {
      const fleet = buildMinimalFleet("eu-fleet");
      assert.equal(fleet.delegation?.aws_region, "eu-west-1");
    } finally {
      if (prev !== undefined) process.env["AWS_REGION"] = prev;
      else delete process.env["AWS_REGION"];
    }
  });

  it("defaults to us-west-2 when no AWS_REGION set", () => {
    const prev = process.env["AWS_REGION"];
    const prevDefault = process.env["AWS_DEFAULT_REGION"];
    delete process.env["AWS_REGION"];
    delete process.env["AWS_DEFAULT_REGION"];
    try {
      const fleet = buildMinimalFleet("default-region-fleet");
      assert.equal(fleet.delegation?.aws_region, "us-west-2");
    } finally {
      if (prev !== undefined) process.env["AWS_REGION"] = prev;
      if (prevDefault !== undefined) process.env["AWS_DEFAULT_REGION"] = prevDefault;
    }
  });

  it("exposes helper methods: getAgent, orchestrator, specialists", () => {
    const fleet = buildMinimalFleet("helper-fleet");
    assert.equal(fleet.getAgent("nonexistent"), undefined);
    assert.equal(fleet.orchestrator, undefined);
    assert.deepEqual(fleet.specialists, []);
  });
});

// ── resolveAndLoadFleet integration ──────────────────────────────────────────

describe("resolveAndLoadFleet", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-load-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads a real fleet.yaml by path", () => {
    const p = path.join(tmpDir, "my-fleet.yaml");
    writeMinimalFleetYaml(p, "real-fleet");
    const fleet = resolveAndLoadFleet(p);
    assert.equal(fleet.fleet.name, "real-fleet");
  });

  it("builds a minimal fleet from a name", () => {
    const fleet = resolveAndLoadFleet("named-fleet");
    assert.equal(fleet.fleet.name, "named-fleet");
    assert.equal(fleet.delegation?.table_name, "named-fleet-tasks");
  });

  it("falls back to CWD fleet.yaml when no flag given (no agent.env)", () => {
    const agentEnvExists = fs.existsSync("/etc/fleetmind/agent.env");
    if (agentEnvExists) return;

    writeMinimalFleetYaml(path.join(tmpDir, "fleet.yaml"), "cwd-fleet");
    const fleet = resolveAndLoadFleet(undefined);
    assert.equal(fleet.fleet.name, "cwd-fleet");
  });
});
