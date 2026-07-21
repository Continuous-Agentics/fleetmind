/**
 * Unit tests for `fleetmind github-app store`.
 *
 * Uses dependency injection (ssmClient option) instead of module mocking —
 * the same pattern as populate.ts uses for promptFn/confirmFn.
 *
 * Covers:
 *   - Three PutParameterCommand calls with correct Name/Type/Value/Overwrite
 *   - app-id and installation-id stored as String; pem as SecureString
 *   - --dry-run makes no SSM calls but prints what would be written
 *   - --pem-file pointing at a non-existent path fails before any SSM call
 *   - --no-overwrite passes Overwrite: false to all three params
 *   - namespace is constructed correctly from fleet + agent
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, describe, beforeEach, afterEach } from "node:test";

import {
  storeGithubApp,
  type GithubAppStoreOptions,
  type SsmSendable,
} from "../cli/commands/github-app.js";
import { PutParameterCommand } from "@aws-sdk/client-ssm";

// ── Mock SSM client factory ───────────────────────────────────────────────────

interface CapturedCall {
  Name: string | undefined;
  Value: string | undefined;
  Type: string | undefined;
  Overwrite: boolean | undefined;
}

function makeMockSsmClient(): { client: SsmSendable; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const client: SsmSendable = {
    async send(cmd: PutParameterCommand) {
      // PutParameterCommand exposes its input via `.input`
      const input = (cmd as unknown as { input: CapturedCall }).input;
      calls.push({
        Name: input.Name,
        Value: input.Value,
        Type: input.Type,
        Overwrite: input.Overwrite,
      });
      return {};
    },
  };
  return { client, calls };
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

let tmpDir: string;
let pemFile: string;
const PEM_CONTENT = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-ghapp-"));
  pemFile = path.join(tmpDir, "test-app.pem");
  fs.writeFileSync(pemFile, PEM_CONTENT + "\n");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Live (mocked SSM via DI) ──────────────────────────────────────────────────

describe("storeGithubApp — live (injected mock SSM)", () => {
  test("writes three SSM params with correct names, types, and values", async () => {
    const { client, calls } = makeMockSsmClient();

    await storeGithubApp({
      fleet: "myfleet",
      agent: "forge",
      appId: "123456",
      installationId: "987654321",
      pemFile,
      region: "us-west-2",
      dryRun: false,
      overwrite: true,
      ssmClient: client,
    });

    assert.equal(calls.length, 3, "should call SSM.send exactly three times");

    const appIdCmd = calls.find((c) => c.Name?.endsWith("/app-id"));
    const instCmd = calls.find((c) => c.Name?.endsWith("/installation-id"));
    const pemCmd = calls.find((c) => c.Name?.endsWith("/pem"));

    assert.ok(appIdCmd, "app-id param should be written");
    assert.equal(appIdCmd.Name, "/fleetmind/myfleet/agents/forge/github-app/app-id");
    assert.equal(appIdCmd.Type, "String");
    assert.equal(appIdCmd.Value, "123456");
    assert.equal(appIdCmd.Overwrite, true);

    assert.ok(instCmd, "installation-id param should be written");
    assert.equal(instCmd.Name, "/fleetmind/myfleet/agents/forge/github-app/installation-id");
    assert.equal(instCmd.Type, "String");
    assert.equal(instCmd.Value, "987654321");
    assert.equal(instCmd.Overwrite, true);

    assert.ok(pemCmd, "pem param should be written");
    assert.equal(pemCmd.Name, "/fleetmind/myfleet/agents/forge/github-app/pem");
    assert.equal(pemCmd.Type, "SecureString");
    assert.ok(pemCmd.Value?.includes("BEGIN RSA PRIVATE KEY"), "pem value should contain PEM contents");
    assert.equal(pemCmd.Overwrite, true);
  });

  test("pem is stored as SecureString, app-id and installation-id as String", async () => {
    const { client, calls } = makeMockSsmClient();

    await storeGithubApp({
      fleet: "f",
      agent: "a",
      appId: "1",
      installationId: "2",
      pemFile,
      region: "us-east-1",
      dryRun: false,
      overwrite: true,
      ssmClient: client,
    });

    const types = calls.map((c) => ({ name: c.Name?.split("/").pop(), type: c.Type }));
    const appId = types.find((t) => t.name === "app-id");
    const instId = types.find((t) => t.name === "installation-id");
    const pem = types.find((t) => t.name === "pem");

    assert.equal(appId?.type, "String");
    assert.equal(instId?.type, "String");
    assert.equal(pem?.type, "SecureString");
  });

  test("--no-overwrite passes Overwrite: false to all three params", async () => {
    const { client, calls } = makeMockSsmClient();

    await storeGithubApp({
      fleet: "f",
      agent: "a",
      appId: "1",
      installationId: "2",
      pemFile,
      region: "us-west-2",
      dryRun: false,
      overwrite: false,
      ssmClient: client,
    });

    assert.equal(calls.length, 3);
    for (const cmd of calls) {
      assert.equal(cmd.Overwrite, false, `expected Overwrite=false for ${cmd.Name}`);
    }
  });

  test("namespace path uses fleet and agent correctly", async () => {
    const { client, calls } = makeMockSsmClient();

    const result = await storeGithubApp({
      fleet: "test-fleet",
      agent: "conductor",
      appId: "99",
      installationId: "88",
      pemFile,
      region: "us-west-2",
      dryRun: false,
      overwrite: true,
      ssmClient: client,
    });

    assert.equal(result.namespace, "/fleetmind/test-fleet/agents/conductor/github-app");
    assert.ok(
      calls.every((c) => c.Name?.startsWith("/fleetmind/test-fleet/agents/conductor/github-app")),
      "all param names should start with the expected namespace"
    );
  });

  test("result has written=true for all params after live write", async () => {
    const { client } = makeMockSsmClient();

    const result = await storeGithubApp({
      fleet: "f",
      agent: "a",
      appId: "1",
      installationId: "2",
      pemFile,
      region: "us-west-2",
      dryRun: false,
      overwrite: true,
      ssmClient: client,
    });

    assert.ok(result.params.every((p) => p.written === true), "all params should be written=true after live write");
  });
});

// ── Dry-run ───────────────────────────────────────────────────────────────────

describe("storeGithubApp — dry-run", () => {
  test("--dry-run makes no SSM calls", async () => {
    const { client, calls } = makeMockSsmClient();

    const origLog = console.log;
    console.log = () => {};
    try {
      await storeGithubApp({
        fleet: "myfleet",
        agent: "forge",
        appId: "123",
        installationId: "456",
        pemFile,
        region: "us-west-2",
        dryRun: true,
        overwrite: true,
        ssmClient: client,
      });
    } finally {
      console.log = origLog;
    }

    assert.equal(calls.length, 0, "dry-run should not call SSM");
  });

  test("--dry-run prints the three param paths and region", async () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));

    try {
      await storeGithubApp({
        fleet: "myfleet",
        agent: "forge",
        appId: "123",
        installationId: "456",
        pemFile,
        region: "eu-west-1",
        dryRun: true,
        overwrite: true,
      });
    } finally {
      console.log = origLog;
    }

    const combined = lines.join("\n");
    assert.ok(combined.includes("app-id"), "dry-run output should mention app-id");
    assert.ok(combined.includes("installation-id"), "dry-run output should mention installation-id");
    assert.ok(combined.includes("pem"), "dry-run output should mention pem");
    assert.ok(combined.includes("eu-west-1"), "dry-run output should mention region");
  });

  test("--dry-run result has written=false for all params", async () => {
    const origLog = console.log;
    console.log = () => {};
    let result;
    try {
      result = await storeGithubApp({
        fleet: "f",
        agent: "a",
        appId: "1",
        installationId: "2",
        pemFile,
        region: "us-west-2",
        dryRun: true,
        overwrite: true,
      });
    } finally {
      console.log = origLog;
    }

    assert.ok(result.params.every((p) => p.written === false), "all params should have written=false in dry-run");
  });

  test("--dry-run does not call SSM even without ssmClient option", async () => {
    // No ssmClient injected — dry-run should not attempt to create SSMClient
    const origLog = console.log;
    console.log = () => {};
    let threw = false;
    try {
      await storeGithubApp({
        fleet: "f",
        agent: "a",
        appId: "1",
        installationId: "2",
        pemFile,
        region: "us-west-2",
        dryRun: true,
        overwrite: true,
        // ssmClient intentionally omitted
      });
    } catch {
      threw = true;
    } finally {
      console.log = origLog;
    }
    assert.equal(threw, false, "dry-run without ssmClient should not throw");
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe("storeGithubApp — validation", () => {
  test("throws early when --pem-file does not exist (no SSM call)", async () => {
    const { client, calls } = makeMockSsmClient();

    await assert.rejects(
      () =>
        storeGithubApp({
          fleet: "f",
          agent: "a",
          appId: "1",
          installationId: "2",
          pemFile: "/nonexistent/path/that-definitely-does-not-exist.pem",
          region: "us-west-2",
          dryRun: false,
          overwrite: true,
          ssmClient: client,
        }),
      /not found/i,
      "should throw with 'not found' message"
    );

    assert.equal(calls.length, 0, "SSM should not be called when pem file is missing");
  });

  test("throws early when --pem-file is empty (no SSM call)", async () => {
    const { client, calls } = makeMockSsmClient();
    const emptyPem = path.join(tmpDir, "empty.pem");
    fs.writeFileSync(emptyPem, "");

    await assert.rejects(
      () =>
        storeGithubApp({
          fleet: "f",
          agent: "a",
          appId: "1",
          installationId: "2",
          pemFile: emptyPem,
          region: "us-west-2",
          dryRun: false,
          overwrite: true,
          ssmClient: client,
        }),
      /empty/i,
      "should throw with 'empty' message for zero-byte PEM"
    );

    assert.equal(calls.length, 0, "SSM should not be called when pem file is empty");
  });

  test("PEM contents are NOT printed to console (only a digest)", async () => {
    const { client } = makeMockSsmClient();
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logged.push(args.join(" "));

    // Dry-run so we can inspect all output paths
    try {
      await storeGithubApp({
        fleet: "f",
        agent: "a",
        appId: "1",
        installationId: "2",
        pemFile,
        region: "us-west-2",
        dryRun: true,
        overwrite: true,
        ssmClient: client,
      });
    } finally {
      console.log = origLog;
    }

    const combined = logged.join("\n");
    assert.ok(
      !combined.includes("BEGIN RSA PRIVATE KEY"),
      "PEM contents should not appear in console output"
    );
  });
});
