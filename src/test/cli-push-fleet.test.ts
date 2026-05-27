/**
 * Unit tests for `fleetmind push fleet`.
 *
 * Uses dependency injection (PushFleetDeps) — no real AWS connection required.
 *
 * Covers:
 *   - --dry-run: produces manifest, doesn't upload or trigger SSM
 *   - happy path: uploads tarball + manifest, sends SSM command per agent
 *   - --no-apply: uploads artifacts but skips SSM trigger
 *   - --agent filter: only pushes the specified agent
 *   - buildManifest: shape, fields, version, rendered_at
 *   - computeFileManifests: sha256, size, relative paths
 *   - buildStagingDir: copies workspace + openclaw.json
 *   - formatBytes: human-readable sizes
 *   - unknown agent: skipped with reason
 */

import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import {
  buildManifest,
  computeFileManifests,
  buildStagingDir,
  formatBytes,
  runPushFleet,
  sha256File,
  type ManifestFile,
  type DeployManifest,
  type PushFleetDeps,
} from "../cli/commands/push-fleet.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeFiles(): ManifestFile[] {
  return [
    { path: "AGENTS.md", size: 4612, sha256: "aaa", mode: 644 },
    { path: ".openclaw/openclaw.json", size: 3284, sha256: "bbb", mode: 644 },
    { path: "SOUL.md", size: 1200, sha256: "ccc", mode: 644 },
  ];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a temp fleet.yaml that points to a local fleet */
function makeTempFleetYaml(dir: string, agentIds: string[] = ["conductor", "forge"]): string {
  const agentList = agentIds
    .map(
      (id, i) => `
    - id: ${id}
      name: ${id.charAt(0).toUpperCase() + id.slice(1)}
      emoji: 🤖
      orchestrator: ${i === 0}
      target: test-host
      persona:
        soul: "Test agent ${id}"
      channels:
        - provider: slack
          account_id: ${id}
          bot_token: "\${${id.toUpperCase()}_BOT_TOKEN}"
          app_token: "\${${id.toUpperCase()}_APP_TOKEN}"
      skills: []`
    )
    .join("");

  const yaml = `
fleet:
  name: test-fleet
targets:
  test-host:
    provider: aws-ssm
    os: linux
    service_manager: systemd
    workspace_base: /opt/openclaw/workspace
    aws:
      region: us-west-2
agents:
  defaults: {}
  list:${agentList}
`.trim();

  const fleetPath = path.join(dir, "fleet.yaml");
  fs.writeFileSync(fleetPath, yaml, "utf-8");
  return fleetPath;
}

/** Create a minimal rendered workspace for an agent */
function makeRenderedWorkspace(baseDir: string, agentId: string): void {
  const wsDir = path.join(baseDir, "rendered", "workspaces", agentId);
  const ocDir = path.join(baseDir, "rendered", "openclaw", agentId);
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(ocDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "SOUL.md"), `# SOUL for ${agentId}`, "utf-8");
  fs.writeFileSync(path.join(wsDir, "AGENTS.md"), `# AGENTS for ${agentId}`, "utf-8");
  fs.writeFileSync(path.join(ocDir, "openclaw.json"), `{"agent":"${agentId}"}`, "utf-8");
}

/** Build a mock PushFleetDeps with call tracking. */
interface MockDepsState {
  tarballCalls: string[];
  s3Uploads: Array<{ bucket: string; key: string; size: number }>;
  instanceLookups: Array<{ fleet: string; agent: string }>;
  ssmCalls: Array<{ instanceId: string; commands: string[] }>;
  ssmCommandIdCounter: number;
}

function makeMockDeps(state: MockDepsState, opts?: { instanceId?: string | null }): PushFleetDeps {
  return {
    async createTarball(stagingDir, destPath) {
      state.tarballCalls.push(destPath);
      // Write a fake tarball so downstream can read it
      const content = Buffer.from(`fake-tarball-for-${path.basename(destPath)}`);
      fs.writeFileSync(destPath, content);
      const sha256 = crypto.createHash("sha256").update(content).digest("hex");
      return { sha256, sizeBytes: content.length };
    },
    // In-memory ArtifactStore; records puts (with the bucket it was built with).
    makeArtifactStore(bucket) {
      const objects = new Map<string, Buffer>();
      return {
        async put(key, body) {
          state.s3Uploads.push({ bucket, key, size: body.length });
          objects.set(key, body);
        },
        async get(key) {
          return objects.get(key) ?? null;
        },
        async copy(srcKey, destKey) {
          const b = objects.get(srcKey);
          if (!b) throw new Error(`NoSuchKey: ${srcKey}`);
          objects.set(destKey, b);
        },
        async list(prefix) {
          return [...objects.keys()].filter((k) => k.startsWith(prefix));
        },
        async delete(key) {
          objects.delete(key);
        },
      };
    },
    makeTargetResolver(fleetName) {
      return {
        async resolveHost(agentId) {
          state.instanceLookups.push({ fleet: fleetName, agent: agentId });
          if (opts?.instanceId === null) return null;
          return opts?.instanceId ?? `i-mock-${agentId}`;
        },
      };
    },
    makeCommandRunner() {
      return {
        async run(hostHandle, commands) {
          state.ssmCalls.push({ instanceId: hostHandle, commands });
          return `ssm-cmd-${++state.ssmCommandIdCounter}`;
        },
      };
    },
    async acquireLock() { /* no-op in tests */ },
    async releaseLock() { /* no-op in tests */ },
    async archiveToHistory() { /* no-op in tests */ },
  };
}

// ── Tests: buildManifest ──────────────────────────────────────────────────────

describe("buildManifest", () => {
  test("produces correct shape with all required fields", () => {
    const files = makeFiles();
    const manifest = buildManifest("conductor", "test-fleet", "0.4.1", files, {
      filename: "conductor.tar.gz",
      sha256: "deadbeef",
      sizeBytes: 92348,
    });

    assert.equal(manifest.agent_id, "conductor");
    assert.equal(manifest.fleet_name, "test-fleet");
    assert.equal(manifest.fleetmind_version, "0.4.1");
    assert.ok(manifest.rendered_at, "rendered_at should be set");
    assert.equal(manifest.tarball.filename, "conductor.tar.gz");
    assert.equal(manifest.tarball.sha256, "deadbeef");
    assert.equal(manifest.tarball.size_bytes, 92348);
    assert.deepEqual(manifest.files, files);
  });

  test("rendered_at is a valid ISO timestamp", () => {
    const manifest = buildManifest("forge", "test-fleet", "0.4.1", [], {
      filename: "forge.tar.gz",
      sha256: "abc",
      sizeBytes: 100,
    });
    assert.ok(!isNaN(Date.parse(manifest.rendered_at)), "rendered_at should be a valid ISO date");
  });

  test("files array is the source of truth and preserved", () => {
    const files = makeFiles();
    const manifest = buildManifest("conductor", "test-fleet", "0.4.1", files, {
      filename: "conductor.tar.gz",
      sha256: "xyz",
      sizeBytes: 0,
    });
    assert.equal(manifest.files.length, 3);
    assert.equal(manifest.files[0]?.path, "AGENTS.md");
  });
});

// ── Tests: computeFileManifests ───────────────────────────────────────────────

describe("computeFileManifests", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-manifest-"));
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "hello agents", "utf-8");
    fs.mkdirSync(path.join(tmpDir, ".openclaw"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".openclaw", "openclaw.json"), "{}", "utf-8");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns files sorted by path with correct shape", () => {
    const files = computeFileManifests(tmpDir);
    assert.ok(files.length >= 2, "should have at least 2 files");
    // Check that paths are relative (no absolute paths)
    for (const f of files) {
      assert.ok(!path.isAbsolute(f.path), `path ${f.path} should be relative`);
      assert.ok(f.sha256.length === 64, "sha256 should be 64 hex chars");
      assert.ok(f.size >= 0, "size should be non-negative");
    }
  });

  test("sha256 matches actual file content", () => {
    const files = computeFileManifests(tmpDir);
    const agentsEntry = files.find((f) => f.path === "AGENTS.md");
    assert.ok(agentsEntry, "should have AGENTS.md");
    const expected = crypto
      .createHash("sha256")
      .update(Buffer.from("hello agents"))
      .digest("hex");
    assert.equal(agentsEntry.sha256, expected);
  });

  test("uses forward-slash separators even on Windows-style paths", () => {
    const files = computeFileManifests(tmpDir);
    for (const f of files) {
      assert.ok(!f.path.includes("\\"), `path ${f.path} should not contain backslashes`);
    }
  });

  test("returns empty array for non-existent directory", () => {
    const files = computeFileManifests(path.join(tmpDir, "nonexistent"));
    assert.deepEqual(files, []);
  });
});

// ── Tests: buildStagingDir ────────────────────────────────────────────────────

describe("buildStagingDir", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-staging-"));
    // workspace dir
    const ws = path.join(tmpDir, "ws");
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, "SOUL.md"), "soul content", "utf-8");
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "agents content", "utf-8");
    // openclaw.json
    const oc = path.join(tmpDir, "oc");
    fs.mkdirSync(oc);
    fs.writeFileSync(path.join(oc, "openclaw.json"), '{"test":true}', "utf-8");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("copies workspace files into staging dir", () => {
    const staging = buildStagingDir(
      "conductor",
      path.join(tmpDir, "ws"),
      path.join(tmpDir, "oc", "openclaw.json"),
      tmpDir
    );
    assert.ok(fs.existsSync(path.join(staging, "SOUL.md")));
    assert.ok(fs.existsSync(path.join(staging, "AGENTS.md")));
    fs.rmSync(staging, { recursive: true, force: true });
  });

  test("copies openclaw.json into .openclaw/ subdirectory", () => {
    const staging = buildStagingDir(
      "conductor",
      path.join(tmpDir, "ws"),
      path.join(tmpDir, "oc", "openclaw.json"),
      tmpDir
    );
    const ocJson = path.join(staging, ".openclaw", "openclaw.json");
    assert.ok(fs.existsSync(ocJson));
    assert.equal(fs.readFileSync(ocJson, "utf-8"), '{"test":true}');
    fs.rmSync(staging, { recursive: true, force: true });
  });
});

// ── Tests: formatBytes ────────────────────────────────────────────────────────

describe("formatBytes", () => {
  test("formats bytes under 1KB", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1023), "1023 B");
  });

  test("formats bytes in KB range", () => {
    assert.equal(formatBytes(1024), "1.0 KB");
    assert.equal(formatBytes(2048), "2.0 KB");
    assert.equal(formatBytes(4612), "4.5 KB");
  });

  test("formats bytes in MB range", () => {
    assert.equal(formatBytes(1024 * 1024), "1.0 MB");
    assert.ok(formatBytes(10 * 1024 * 1024).endsWith("MB"));
  });
});

// ── Tests: runPushFleet — dry-run ─────────────────────────────────────────────

describe("runPushFleet — dry-run", () => {
  let tmpDir: string;
  let fleetPath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-push-dr-"));
    fleetPath = makeTempFleetYaml(tmpDir, ["conductor", "forge"]);
    makeRenderedWorkspace(tmpDir, "conductor");
    makeRenderedWorkspace(tmpDir, "forge");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("dry-run: computes manifests but does not upload to S3", async () => {
    const state: MockDepsState = {
      tarballCalls: [],
      s3Uploads: [],
      instanceLookups: [],
      ssmCalls: [],
      ssmCommandIdCounter: 0,
    };
    const deps = makeMockDeps(state);

    const results = await runPushFleet(
      {
        fleet: fleetPath,
        agents: [],
        region: "us-west-2",
        restart: false,
        dryRun: true,
        noApply: false,
        localBase: tmpDir,
      },
      deps
    );

    assert.equal(state.s3Uploads.length, 0, "dry-run should not upload");
    assert.equal(state.ssmCalls.length, 0, "dry-run should not send SSM");
    assert.ok(results.every((r) => r.status === "skipped"), "all should be skipped in dry-run");
  });

  test("dry-run: does not call createTarball (packaging is skipped)", async () => {
    const state: MockDepsState = {
      tarballCalls: [],
      s3Uploads: [],
      instanceLookups: [],
      ssmCalls: [],
      ssmCommandIdCounter: 0,
    };
    await runPushFleet(
      {
        fleet: fleetPath,
        agents: [],
        region: "us-west-2",
        restart: false,
        dryRun: true,
        noApply: false,
        localBase: tmpDir,
      },
      makeMockDeps(state)
    );
    assert.equal(state.tarballCalls.length, 0, "dry-run should not create tarballs");
  });
});

// ── Tests: runPushFleet — happy path ─────────────────────────────────────────

describe("runPushFleet — happy path", () => {
  let tmpDir: string;
  let fleetPath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-push-hp-"));
    fleetPath = makeTempFleetYaml(tmpDir, ["conductor", "forge"]);
    makeRenderedWorkspace(tmpDir, "conductor");
    makeRenderedWorkspace(tmpDir, "forge");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("uploads tarball + manifest to S3 for each agent", async () => {
    const state: MockDepsState = {
      tarballCalls: [],
      s3Uploads: [],
      instanceLookups: [],
      ssmCalls: [],
      ssmCommandIdCounter: 0,
    };

    await runPushFleet(
      {
        fleet: fleetPath,
        agents: [],
        region: "us-west-2",
        restart: false,
        dryRun: false,
        noApply: false,
        localBase: tmpDir,
      },
      makeMockDeps(state)
    );

    // 2 agents × 2 uploads (tarball + manifest) = 4 uploads
    assert.equal(state.s3Uploads.length, 4, "should upload tarball + manifest for each agent");
    const keys = state.s3Uploads.map((u) => u.key).sort();
    assert.ok(keys.some((k) => k === "deploy-staging/conductor.tar.gz"));
    assert.ok(keys.some((k) => k === "deploy-staging/conductor.manifest.json"));
    assert.ok(keys.some((k) => k === "deploy-staging/forge.tar.gz"));
    assert.ok(keys.some((k) => k === "deploy-staging/forge.manifest.json"));
  });

  test("sends SSM command for each agent after upload", async () => {
    const state: MockDepsState = {
      tarballCalls: [],
      s3Uploads: [],
      instanceLookups: [],
      ssmCalls: [],
      ssmCommandIdCounter: 0,
    };

    const results = await runPushFleet(
      {
        fleet: fleetPath,
        agents: [],
        region: "us-west-2",
        restart: false,
        dryRun: false,
        noApply: false,
        localBase: tmpDir,
      },
      makeMockDeps(state)
    );

    assert.equal(state.ssmCalls.length, 2, "should send SSM command for each agent");
    for (const r of results) {
      assert.equal(r.status, "pushed");
      assert.ok(r.ssm_command_id, "should have SSM command ID");
    }
  });

  test("SSM command includes --apply and --region flags", async () => {
    const state: MockDepsState = {
      tarballCalls: [],
      s3Uploads: [],
      instanceLookups: [],
      ssmCalls: [],
      ssmCommandIdCounter: 0,
    };

    await runPushFleet(
      {
        fleet: fleetPath,
        agents: [],
        region: "eu-west-1",
        restart: false,
        dryRun: false,
        noApply: false,
        localBase: tmpDir,
      },
      makeMockDeps(state)
    );

    for (const call of state.ssmCalls) {
      const cmd = call.commands.join(" ");
      assert.ok(cmd.includes("--apply"), "SSM command should include --apply");
      assert.ok(cmd.includes("--region eu-west-1"), "SSM command should include --region");
      assert.ok(!cmd.includes("--restart"), "SSM command should not include --restart by default");
    }
  });

  test("SSM command includes --restart when opts.restart=true", async () => {
    const state: MockDepsState = {
      tarballCalls: [],
      s3Uploads: [],
      instanceLookups: [],
      ssmCalls: [],
      ssmCommandIdCounter: 0,
    };

    await runPushFleet(
      {
        fleet: fleetPath,
        agents: [],
        region: "us-west-2",
        restart: true,
        dryRun: false,
        noApply: false,
        localBase: tmpDir,
      },
      makeMockDeps(state)
    );

    for (const call of state.ssmCalls) {
      const cmd = call.commands.join(" ");
      assert.ok(cmd.includes("--restart"), "SSM command should include --restart");
    }
  });

  test("uploads to correct S3 bucket: <fleetName>-ledger", async () => {
    const state: MockDepsState = {
      tarballCalls: [],
      s3Uploads: [],
      instanceLookups: [],
      ssmCalls: [],
      ssmCommandIdCounter: 0,
    };

    await runPushFleet(
      {
        fleet: fleetPath,
        agents: [],
        region: "us-west-2",
        restart: false,
        dryRun: false,
        noApply: false,
        localBase: tmpDir,
      },
      makeMockDeps(state)
    );

    for (const upload of state.s3Uploads) {
      assert.equal(upload.bucket, "test-fleet-ledger");
    }
  });
});

// ── Tests: runPushFleet — --no-apply ─────────────────────────────────────────

describe("runPushFleet — --no-apply", () => {
  let tmpDir: string;
  let fleetPath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-push-na-"));
    fleetPath = makeTempFleetYaml(tmpDir, ["conductor"]);
    makeRenderedWorkspace(tmpDir, "conductor");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("--no-apply: uploads to S3 but does not trigger SSM", async () => {
    const state: MockDepsState = {
      tarballCalls: [],
      s3Uploads: [],
      instanceLookups: [],
      ssmCalls: [],
      ssmCommandIdCounter: 0,
    };

    const results = await runPushFleet(
      {
        fleet: fleetPath,
        agents: [],
        region: "us-west-2",
        restart: false,
        dryRun: false,
        noApply: true,
        localBase: tmpDir,
      },
      makeMockDeps(state)
    );

    assert.ok(state.s3Uploads.length > 0, "--no-apply should still upload");
    assert.equal(state.ssmCalls.length, 0, "--no-apply should NOT send SSM commands");
    assert.ok(results.every((r) => r.status === "pushed"));
  });
});

// ── Tests: runPushFleet — --agent filter ─────────────────────────────────────

describe("runPushFleet — agent filter", () => {
  let tmpDir: string;
  let fleetPath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-push-af-"));
    fleetPath = makeTempFleetYaml(tmpDir, ["conductor", "forge"]);
    makeRenderedWorkspace(tmpDir, "conductor");
    makeRenderedWorkspace(tmpDir, "forge");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("--agent conductor: only pushes conductor, skips forge", async () => {
    const state: MockDepsState = {
      tarballCalls: [],
      s3Uploads: [],
      instanceLookups: [],
      ssmCalls: [],
      ssmCommandIdCounter: 0,
    };

    const results = await runPushFleet(
      {
        fleet: fleetPath,
        agents: ["conductor"],
        region: "us-west-2",
        restart: false,
        dryRun: false,
        noApply: false,
        localBase: tmpDir,
      },
      makeMockDeps(state)
    );

    assert.equal(results.length, 1, "only one agent should be processed");
    assert.equal(results[0]?.agent_id, "conductor");
    const conductorUploads = state.s3Uploads.filter((u) => u.key.includes("conductor"));
    const forgeUploads = state.s3Uploads.filter((u) => u.key.includes("forge"));
    assert.ok(conductorUploads.length > 0, "conductor should have uploads");
    assert.equal(forgeUploads.length, 0, "forge should have no uploads");
  });

  test("unknown agent ID: returns skipped result", async () => {
    const state: MockDepsState = {
      tarballCalls: [],
      s3Uploads: [],
      instanceLookups: [],
      ssmCalls: [],
      ssmCommandIdCounter: 0,
    };

    const results = await runPushFleet(
      {
        fleet: fleetPath,
        agents: ["nonexistent-bot"],
        region: "us-west-2",
        restart: false,
        dryRun: false,
        noApply: false,
        localBase: tmpDir,
      },
      makeMockDeps(state)
    );

    assert.equal(results.length, 1);
    assert.equal(results[0]?.agent_id, "nonexistent-bot");
    assert.equal(results[0]?.status, "skipped");
    assert.ok(results[0]?.reason?.includes("not found"));
  });
});

// ── Tests: runPushFleet — instance not in SSM (graceful skip) ────────────────

describe("runPushFleet — instance not in SSM", () => {
  let tmpDir: string;
  let fleetPath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-push-ssm-"));
    fleetPath = makeTempFleetYaml(tmpDir, ["conductor"]);
    makeRenderedWorkspace(tmpDir, "conductor");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("gracefully skips SSM trigger when instance is not found", async () => {
    const state: MockDepsState = {
      tarballCalls: [],
      s3Uploads: [],
      instanceLookups: [],
      ssmCalls: [],
      ssmCommandIdCounter: 0,
    };

    // Instance lookup returns null (not registered in SSM)
    const results = await runPushFleet(
      {
        fleet: fleetPath,
        agents: [],
        region: "us-west-2",
        restart: false,
        dryRun: false,
        noApply: false,
        localBase: tmpDir,
      },
      makeMockDeps(state, { instanceId: null })
    );

    // Upload still happened
    assert.ok(state.s3Uploads.length > 0);
    // But no SSM
    assert.equal(state.ssmCalls.length, 0);
    // Result still marked as pushed (upload succeeded)
    assert.equal(results[0]?.status, "pushed");
  });
});
