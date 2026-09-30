import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { STSClient } from "@aws-sdk/client-sts";
import { SSMClient } from "@aws-sdk/client-ssm";
import { EC2Client } from "@aws-sdk/client-ec2";
import { IAMClient } from "@aws-sdk/client-iam";
import { registerAwsAccess } from "../cli/commands/aws-access.js";
import { FleetSchema } from "../config/schema.js";
import { normalizeFleet } from "../core/model.js";
import { renderTerraformVars } from "../runtime/renderer.js";
import { agentAccessCatalog } from "../deploy/aws-access.js";

const role = "arn:aws:iam::111111111111:role/fleet-worker-role";
const profile = "arn:aws:iam::111111111111:instance-profile/fleet-worker";
const target = { app: "orders", environment: "staging", access: "read", account_id: "222222222222", role_arn: "arn:aws:iam::222222222222:role/orders-read", region: "us-west-2" };
const raw = (): any => ({ fleet: { name: "fleet" }, targets: { host: { provider: "aws-ssm", aws: { region: "us-west-2", account_id: "111111111111", workload_role_arn: role } } }, aws_access: { orders: target, other: { ...target, role_arn: "arn:aws:iam::222222222222:role/other" } }, agents: { defaults: { target: "host" }, list: [{ id: "worker", name: "Worker", aws_access: { source_role_arn: role, targets: ["orders"] } }] } });

test("MF1: every duplicate order rejects before IAM/catalog derivation, including normalization bypass", () => {
  for (const different of [false, true]) for (const reverse of [false, true]) {
    const input = raw();
    const duplicate = { id: "worker", name: "Duplicate", ...(different ? { aws_access: { source_role_arn: role, targets: ["other"] } } : {}) };
    input.agents.list[reverse ? "unshift" : "push"](duplicate);
    assert.throws(() => renderTerraformVars(normalizeFleet(FleetSchema.parse(input))), /Duplicate agent ID/);
    assert.throws(() => agentAccessCatalog(normalizeFleet(input), "worker"), /Duplicate agent ID/);
  }
});

test("MF2: production Commander/loader/sync SDK path pins credentials and rejects unsafe publication", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fm-sync-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // Explicit synthetic operator input only; all four SDK sends are intercepted.
  t.mock.method(console, "error", () => {}); t.mock.method(console, "log", () => {});
  const originalEnv = { ...process.env };
  const previousExit = process.exitCode;
  t.after(() => { process.env = originalEnv; process.exitCode = previousExit; });
  process.env.AWS_ACCESS_KEY_ID = "SYNTHETIC_OPERATOR";
  process.env.AWS_SECRET_ACCESS_KEY = "SYNTHETIC_SECRET";
  let mode = "ok";
  let calls: string[] = [];
  let submitted: any;
  const pinned = async (client: any) => {
    const c = await client.config.credentials();
    assert.equal(c.accessKeyId, "SYNTHETIC_OPERATOR");
    assert.equal(c.secretAccessKey, "SYNTHETIC_SECRET");
  };
  t.mock.method(STSClient.prototype, "send", async function(this: STSClient) {
    calls.push("identity"); await pinned(this);
    // If any later client resolves ambient credentials again it will see this change.
    process.env.AWS_ACCESS_KEY_ID = "CHANGED_AFTER_IDENTITY";
    return { Account: mode.startsWith("wrong-account") ? "999999999999" : "111111111111", Arn: "arn:aws:iam::111111111111:user/operator" };
  });
  t.mock.method(SSMClient.prototype, "send", async function(this: SSMClient, command: any) {
    await pinned(this);
    if (command.constructor.name === "SendCommandCommand") { calls.push("submit"); submitted = command.input; return { Command: { CommandId: "synthetic-receipt" } }; }
    assert.equal(command.constructor.name, "DescribeInstanceInformationCommand");
    assert.equal(calls[0], "identity"); calls.push("discover");
    if (mode === "zero") return {};
    if (mode === "ambiguous") return { InstanceInformationList: [{ InstanceId: "i-abc" }, { InstanceId: "i-def" }] };
    if (["ambiguous-pages", "pagination", "repeated-token"].includes(mode)) {
      if (!command.input.NextToken) return { InstanceInformationList: [{ InstanceId: "i-abc" }], NextToken: "next" };
      assert.equal(command.input.NextToken, "next");
      return { InstanceInformationList: mode === "ambiguous-pages" ? [{ InstanceId: "i-def" }] : [], ...(mode === "repeated-token" ? { NextToken: "next" } : {}) };
    }
    return { InstanceInformationList: [{ InstanceId: "i-abc" }] };
  });
  t.mock.method(EC2Client.prototype, "send", async function(this: EC2Client) {
    calls.push("ec2"); await pinned(this);
    return { Reservations: [{ OwnerId: "111111111111", Instances: [{ InstanceId: "i-abc", State: { Name: "running" }, IamInstanceProfile: { Arn: profile }, Tags: [{ Key: "fleetmind:fleet_name", Value: "fleet" }, { Key: "fleetmind:agent_id", Value: mode === "wrong-agent" ? "peer" : "worker" }] }] }] };
  });
  t.mock.method(IAMClient.prototype, "send", async function(this: IAMClient) {
    calls.push("iam"); await pinned(this);
    return { InstanceProfile: { Arn: profile, Roles: [{ Arn: mode === "wrong-role" ? role + "-other" : role }] } };
  });
  for (mode of ["wrong-account", "wrong-account-revoke", "zero", "ambiguous", "ambiguous-pages", "repeated-token", "wrong-agent", "wrong-role", "mismatched-catalog", "missing-binding-revoke", "duplicates", "duplicates-reversed", "different-duplicates", "different-duplicates-reversed", "invalid-revision", "unsafe-revision", "ok", "pagination", "revoke"]) {
    calls = []; submitted = undefined; process.exitCode = 0;
    process.env.AWS_ACCESS_KEY_ID = "SYNTHETIC_OPERATOR";
    const config = raw();
    if (mode.includes("revoke")) delete config.agents.list[0].aws_access;
    if (mode === "missing-binding-revoke") delete config.targets.host.aws.account_id;
    if (mode === "mismatched-catalog") config.agents.list[0].aws_access.source_role_arn = role + "-other";
    if (mode.includes("duplicates")) {
      const duplicate = { id: "worker", name: "Duplicate", ...(mode.startsWith("different") ? { aws_access: { source_role_arn: role, targets: ["other"] } } : {}) };
      config.agents.list[mode.endsWith("reversed") ? "unshift" : "push"](duplicate);
    }
    const file = path.join(directory, "fleet.yaml"); fs.writeFileSync(file, JSON.stringify(config));
    const program = new Command().version("1.2.1"); registerAwsAccess(program);
    await program.parseAsync(["node", "test", "aws-access", "sync", "--fleet", file, "--agent", "worker", "--revision", mode === "invalid-revision" ? "1e3" : mode === "unsafe-revision" ? "9007199254740992" : "42"]);
    const success = ["ok", "pagination", "revoke"].includes(mode);
    assert.equal(process.exitCode, success ? 0 : 1, mode);
    assert.equal(!!submitted, success, mode);
    if (mode.startsWith("wrong-account")) assert.deepEqual(calls, ["identity"]);
    if (mode.includes("duplicates") || mode === "mismatched-catalog" || mode === "missing-binding-revoke" || mode.endsWith("revision")) assert.deepEqual(calls, []);
    if (mode === "pagination" || mode === "ambiguous-pages") assert.equal(calls.filter(c => c === "discover").length, 2);
    if (success) {
      assert.deepEqual(submitted.InstanceIds, ["i-abc"]);
      assert.match(submitted.Parameters.commands[0], /fleetmind-aws-access-sync-v3/);
      const encoded = submitted.Parameters.commands[0].match(/aws-access publish '([^']+)'/)[1];
      const payload = JSON.parse(Buffer.from(encoded, "base64").toString());
      assert.equal(payload.revision, 42);
      assert.equal(payload.host.account_id, "111111111111"); assert.equal(payload.host.role_arn, role);
      assert.equal(payload.catalog === null, mode === "revoke");
    }
  }
});
