import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceMode = import.meta.url.endsWith(".ts");
const cli = path.resolve(
  testDir,
  sourceMode ? "../cli/index.ts" : "../cli/index.js",
);
// Resolve before child processes change cwd to an isolated fixture. A bare
// `tsx/esm` specifier would otherwise resolve relative to the fixture and fail.
const sourceLoader = sourceMode
  ? pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href
  : undefined;
const roots: string[] = [];

afterEach(() => {
  while (roots.length)
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(
  role: "worker" | "backend-worker",
  delegationEnabled: boolean,
): { root: string; fleet: string } {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "fleetmind-manifest-policy-"),
  );
  roots.push(root);
  const fleet = path.join(root, "fleet.yaml");
  fs.writeFileSync(
    fleet,
    `fleet:
  name: policy-test
targets:
  box: { provider: local }
agents:
  defaults: { target: box }
  list:
    - id: agent
      name: Agent
      role: ${role}
      skills: []
      github_apps:
        project: {}
delegation:
  enabled: ${delegationEnabled}
${delegationEnabled ? "  table_name: policy-test-tasks\n  s3_bucket: policy-test-ledger\n" : ""}outputs:
  openclaw_json: ./rendered/openclaw.json
  terraform_vars: ./rendered/fleet.tfvars
  workspace_manifests: ./rendered/workspaces
openclaw:
  tools:
    web_search: { enabled: false }
`,
  );
  return { root, fleet };
}

function run(root: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [...(sourceLoader ? ["--import", sourceLoader] : []), cli, ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
}

describe("render/doctor conditional manifest policy", () => {
  it("passes disabled worker fleets and normal render does not inject delegation skills", () => {
    const { root, fleet } = fixture("worker", false);
    assert.equal(run(root, ["render", "--check", "--fleet", fleet]).status, 0);
    assert.equal(run(root, ["doctor", "--fleet", fleet]).status, 0);
    assert.equal(run(root, ["render", "--fleet", fleet]).status, 0);
    const parsed = parseYaml(fs.readFileSync(fleet, "utf8"));
    assert.deepEqual(parsed.agents.list[0].skills, []);
  });

  it("still checks and injects delegation skills when enabled", () => {
    const { root, fleet } = fixture("worker", true);
    const check = run(root, ["render", "--check", "--fleet", fleet]);
    assert.equal(check.status, 1);
    assert.match(`${check.stdout}${check.stderr}`, /bot-reception/);
    assert.equal(run(root, ["render", "--fleet", fleet]).status, 0);
    const names = parseYaml(
      fs.readFileSync(fleet, "utf8"),
    ).agents.list[0].skills.map((s: { name: string }) => s.name);
    assert.deepEqual(names.sort(), ["bot-reception", "worker-self-start"]);
  });

  it("keeps unrelated role requirements active when delegation is disabled", () => {
    const { root, fleet } = fixture("backend-worker", false);
    const doctor = run(root, ["doctor", "--fleet", fleet]);
    assert.equal(doctor.status, 1);
    const output = `${doctor.stdout}${doctor.stderr}`;
    assert.match(output, /structured-pr-review/);
    assert.doesNotMatch(output, /bot-reception/);
    assert.equal(run(root, ["render", "--fleet", fleet]).status, 0);
    const names = parseYaml(
      fs.readFileSync(fleet, "utf8"),
    ).agents.list[0].skills.map((s: { name: string }) => s.name);
    assert.deepEqual(names, ["structured-pr-review"]);
  });
});
