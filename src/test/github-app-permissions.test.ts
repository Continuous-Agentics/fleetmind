import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadPermissionsManifestForRole,
  resolveGitHubAppConfig,
} from "../runtime/github-app-permissions.js";

let tmpRoot: string;

function writeManifest(botType: string, contents: string): void {
  const dir = path.join(tmpRoot, "openclaw", botType);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "github-app-permissions.yaml"), contents, "utf-8");
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ghapp-perms-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadPermissionsManifestForRole", () => {
  it("returns null when no manifest exists for the role", () => {
    assert.equal(loadPermissionsManifestForRole("pm", tmpRoot), null);
  });

  it("returns null for unknown role", () => {
    assert.equal(loadPermissionsManifestForRole("definitely-not-a-real-role", tmpRoot), null);
  });

  it("parses a basic permissions manifest", () => {
    writeManifest(
      "pm-bot",
      `role: pm\npermissions:\n  issues: write\n  metadata: read\nevents: []\n`,
    );
    const result = loadPermissionsManifestForRole("pm", tmpRoot);
    assert.equal(result?.role, "pm");
    assert.equal(result?.permissions.issues, "write");
    assert.equal(result?.permissions.metadata, "read");
    assert.deepEqual(result?.events, []);
  });

  it("throws when the manifest role doesn't match the requested role", () => {
    writeManifest("pm-bot", `role: worker\npermissions: {}\n`);
    assert.throws(() => loadPermissionsManifestForRole("pm", tmpRoot), /declares role="worker" but expected "pm"/);
  });

  it("throws on invalid permission level via Zod", () => {
    writeManifest("pm-bot", `role: pm\npermissions:\n  issues: bogus\n`);
    assert.throws(() => loadPermissionsManifestForRole("pm", tmpRoot), /failed validation/);
  });
});

describe("resolveGitHubAppConfig", () => {
  beforeEach(() => {
    writeManifest(
      "pm-bot",
      `role: pm\npermissions:\n  issues: write\n  metadata: read\nevents: []\n`,
    );
    writeManifest(
      "backend-worker-bot",
      `role: backend-worker\npermissions:\n  contents: write\n  pull_requests: write\n  issues: write\nevents: []\n`,
    );
  });

  it("returns per-bot-type defaults when no override given", () => {
    const resolved = resolveGitHubAppConfig("pm", undefined, tmpRoot);
    assert.equal(resolved.permissions.issues, "write");
    assert.equal(resolved.permissions.metadata, "read");
    assert.equal(resolved.source.permissionsFromManifest, 2);
    assert.equal(resolved.source.permissionsFromOverride, 0);
  });

  it("per-agent override adds new keys to the manifest baseline", () => {
    const resolved = resolveGitHubAppConfig(
      "pm",
      { permissions: { contents: "read" }, events: [] },
      tmpRoot,
    );
    assert.equal(resolved.permissions.contents, "read", "agent-added key present");
    assert.equal(resolved.permissions.issues, "write", "manifest key preserved");
    assert.equal(resolved.source.permissionsFromOverride, 1);
    assert.equal(resolved.source.permissionsFromManifest, 2);
  });

  it("per-agent override upgrades an existing manifest key", () => {
    const resolved = resolveGitHubAppConfig(
      "pm",
      { permissions: { metadata: "write" }, events: [] },
      tmpRoot,
    );
    assert.equal(resolved.permissions.metadata, "write", "override wins over manifest");
  });

  it("per-agent 'none' drops a manifest key from the final set", () => {
    const resolved = resolveGitHubAppConfig(
      "backend-worker",
      { permissions: { actions: "none", pull_requests: "none" }, events: [] },
      tmpRoot,
    );
    assert.equal(resolved.permissions.contents, "write", "non-none baseline preserved");
    assert.equal(resolved.permissions.issues, "write");
    assert.ok(!("pull_requests" in resolved.permissions), "pull_requests dropped via 'none'");
    assert.equal(resolved.source.permissionsDropped, 2);
  });

  it("falls back to empty permissions when no manifest + no override", () => {
    const resolved = resolveGitHubAppConfig("worker", undefined, tmpRoot);
    assert.deepEqual(resolved.permissions, {});
  });

  it("events override entirely (not merged)", () => {
    writeManifest(
      "pm-bot",
      `role: pm\npermissions: {}\nevents:\n  - issues\n  - issue_comment\n`,
    );
    const resolved = resolveGitHubAppConfig(
      "pm",
      { permissions: {}, events: ["pull_request"] },
      tmpRoot,
    );
    assert.deepEqual(resolved.events, ["pull_request"], "agent events replace, not merge");
    assert.equal(resolved.source.eventsFrom, "agent");
  });

  it("falls back to manifest events when agent doesn't declare any", () => {
    writeManifest(
      "pm-bot",
      `role: pm\npermissions: {}\nevents:\n  - issues\n`,
    );
    const resolved = resolveGitHubAppConfig("pm", { permissions: {}, events: [] }, tmpRoot);
    assert.deepEqual(resolved.events, ["issues"]);
    assert.equal(resolved.source.eventsFrom, "manifest");
  });
});
