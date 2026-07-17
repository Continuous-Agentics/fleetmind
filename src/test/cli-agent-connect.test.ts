import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
  buildGatewayAuthSecretCommand,
  extractGatewayTokenFromSecretString,
} from "../cli/commands/agent.js";

function withTempFiles(
  config: unknown,
  envContent: string,
  fn: (paths: { configPath: string; envPath: string }) => void,
): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetmind-agent-connect-"));
  try {
    const configPath = path.join(tmpDir, "openclaw.json");
    const envPath = path.join(tmpDir, "openclaw-forge.env");
    fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
    fs.writeFileSync(envPath, envContent, "utf8");
    fn({ configPath, envPath });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function run(command: string): string {
  return execFileSync("bash", ["-lc", command], { encoding: "utf8" }).trim();
}

describe("agent connect preflight auth secret", () => {
  test("extracts the gateway token from the Secrets Manager payload", () => {
    assert.equal(
      extractGatewayTokenFromSecretString(JSON.stringify({ GATEWAY_TOKEN: "secret-manager-token" })),
      "secret-manager-token",
    );
  });

  test("rejects bootstrap placeholders from the Secrets Manager payload", () => {
    assert.equal(
      extractGatewayTokenFromSecretString(JSON.stringify({ GATEWAY_TOKEN: "PENDING_BOOTSTRAP" })),
      null,
    );
    assert.equal(
      extractGatewayTokenFromSecretString(JSON.stringify({ GATEWAY_TOKEN: "${FORGE_GATEWAY_TOKEN}" })),
      null,
    );
  });

  test("resolves rendered gateway token placeholder from runtime env file", () => {
    withTempFiles(
      { gateway: { auth: { mode: "token", token: "${FORGE_GATEWAY_TOKEN}" } } },
      "FORGE_GATEWAY_TOKEN=resolved-token-123\n",
      ({ configPath, envPath }) => {
        const output = run(buildGatewayAuthSecretCommand(configPath, envPath));
        assert.equal(output, "resolved-token-123");
      },
    );
  });

  test("prints literal gateway secret values unchanged", () => {
    withTempFiles(
      { gateway: { auth: { mode: "token", token: "literal-token-456" } } },
      "FORGE_GATEWAY_TOKEN=ignored\n",
      ({ configPath, envPath }) => {
        const output = run(buildGatewayAuthSecretCommand(configPath, envPath));
        assert.equal(output, "literal-token-456");
      },
    );
  });

  test("falls back to canonical GATEWAY_TOKEN when agent-specific alias is absent", () => {
    withTempFiles(
      { gateway: { auth: { mode: "token", token: "${FORGE_GATEWAY_TOKEN}" } } },
      "GATEWAY_TOKEN=canonical-token-789\n",
      ({ configPath, envPath }) => {
        const output = run(buildGatewayAuthSecretCommand(configPath, envPath));
        assert.equal(output, "canonical-token-789");
      },
    );
  });

  test("marks unresolved placeholders explicitly", () => {
    withTempFiles(
      { gateway: { auth: { mode: "token", token: "${FORGE_GATEWAY_TOKEN}" } } },
      "",
      ({ configPath, envPath }) => {
        const output = run(buildGatewayAuthSecretCommand(configPath, envPath));
        assert.equal(output, "__FLEETMIND_UNRESOLVED_GATEWAY_AUTH__:FORGE_GATEWAY_TOKEN");
      },
    );
  });
});
