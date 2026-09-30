import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { FleetSchema } from "../config/schema.js";
import { normalizeFleet } from "../core/model.js";
import { AwsAccessTarget, AwsAgentAccess, RuntimeAwsAccess } from "../config/aws-access.js";
import { agentAccessCatalog, accessSyncCommand } from "../deploy/aws-access.js";
import { renderTerraformVars, renderAgentFleetYaml } from "../runtime/renderer.js";
import { authorizeTask, cleanAccessEnvironment, taskEnvironment, readAccessCatalog, executeTask, type AccessDeps, type Credentials } from "../runtime/aws-access.js";

const sourceRole = "arn:aws:iam::111111111111:role/fleet-worker-role";
const target = { app: "orders", environment: "staging", access: "read", account_id: "222222222222", role_arn: "arn:aws:iam::222222222222:role/app/orders-read", region: "us-west-2", duration_seconds: 900 };
const other = { ...target, account_id: "333333333333", role_arn: "arn:aws:iam::333333333333:role/other-read" };
const raw = () => ({ fleet: { name: "fleet" }, targets: { host: { provider: "aws-ssm", aws: { region: "us-west-2" } } },
  aws_access: { orders: target, other }, agents: { defaults: { target: "host" }, list: [
    { id: "worker", name: "Worker", aws_access: { source_role_arn: sourceRole, targets: ["orders"] } },
    { id: "peer", name: "Peer", aws_access: { source_role_arn: "arn:aws:iam::111111111111:role/fleet-peer-role", targets: ["other"] } },
  ] } });
const fleet = () => normalizeFleet(FleetSchema.parse(raw()));
const credentials = (): Credentials => ({ accessKeyId: "temporary-key", secretAccessKey: "secret-never-log", sessionToken: "token-never-log", expiration: new Date(Date.now() + 900_000) });
function fixture() {
  const events: Record<string, string>[] = [];
  let session = "";
  let assumes = 0;
  const deps: AccessDeps = {
    readCatalog: () => agentAccessCatalog(fleet(), "worker")!,
    source: async () => ({ ...credentials(), accessKeyId: "source" }),
    identity: async creds => creds.accessKeyId === "source"
      ? { Account: "111111111111", Arn: "arn:aws:sts::111111111111:assumed-role/fleet-worker-role/i-host" }
      : { Account: "222222222222", Arn: `arn:aws:sts::222222222222:assumed-role/orders-read/${session}` },
    assume: async (_creds, region, role, name, duration) => {
      assert.equal(region, target.region); assert.equal(role, target.role_arn); assert.equal(duration, 900);
      assumes++; session = name; return credentials();
    },
    now: Date.now,
    audit: e => events.push(e),
  };
  return { deps, events, assumes: () => assumes };
}

test("catalog/account ARN and grant validation fail closed", () => {
  for (const role_arn of ["arn:aws:iam::222222222222:root", "arn:aws:iam::*:role/app", "arn:aws:iam::222222222222:role/*", "arn:aws:iam::333333333333:role/app", "arn:aws:sts::222222222222:assumed-role/app/session"]) {
    assert.equal(AwsAccessTarget.safeParse({ ...target, role_arn }).success, false);
  }
  assert.equal(AwsAccessTarget.safeParse({ ...target, secret: "nope" }).success, false);
  assert.equal(AwsAccessTarget.safeParse({ ...target, duration_seconds: 3601 }).success, false);
  assert.equal(AwsAgentAccess.safeParse({ source_role_arn: sourceRole, targets: ["orders", "orders"] }).success, false);
  const config = raw(); config.agents.list[0].aws_access.targets = ["missing"];
  assert.throws(() => normalizeFleet(FleetSchema.parse(config)), /unknown AWS access grant/);
  assert.throws(() => normalizeFleet(FleetSchema.parse({ ...raw(), targets: { host: { provider: "local" } } })), /requires an aws-ssm host/);
});

test("per-agent catalogs contain only allowed targets; workspace slices expose none", () => {
  const f = fleet();
  assert.deepEqual(Object.keys(agentAccessCatalog(f, "worker")!.targets), ["orders"]);
  const serialized = JSON.stringify(agentAccessCatalog(f, "worker"));
  assert.ok(!serialized.includes(other.account_id));
  assert.ok(!renderAgentFleetYaml(f, "worker").includes("aws_access"));
  assert.ok(!renderAgentFleetYaml(f, "worker").includes(other.role_arn));
  const tfvars = renderTerraformVars(f);
  const roles = JSON.parse(tfvars.split("agent_aws_access_roles = ")[1].split("\n\n# NOTE:")[0]);
  assert.deepEqual(roles, { worker: [target.role_arn], peer: [other.role_arn] });
});

test("legacy absent declarations leave rendering and empty IAM extension unchanged", () => {
  const legacy = raw() as any; delete legacy.aws_access;
  for (const a of legacy.agents.list) delete a.aws_access;
  const f = normalizeFleet(FleetSchema.parse(legacy));
  assert.equal(agentAccessCatalog(f, "worker"), null);
  assert.ok(!renderTerraformVars(f).includes("agent_aws_access_roles"));
});

test("positive source/target identity and nonsecret audit", async () => {
  const { deps, events, assumes } = fixture();
  const result = await authorizeTask("orders", deps);
  assert.equal(assumes(), 1); assert.equal(result.region, "us-west-2");
  assert.equal(events[0].event, "aws-access.authorized");
  assert.match(events[0].identity, /assumed-role\/orders-read\/fm-worker-/);
  for (const secret of ["temporary-key", "secret-never-log", "token-never-log"]) assert.ok(!JSON.stringify(events).includes(secret));
});

test("unknown and unauthorized targets never call STS or echo attacker input", async () => {
  for (const alias of ["other", "missing\nsecret", "__proto__", target.role_arn]) {
    const { deps, events, assumes } = fixture();
    deps.source = async () => { throw new Error("Source must not be consulted"); };
    await assert.rejects(authorizeTask(alias, deps), /AWS access denied/);
    assert.equal(assumes(), 0); assert.deepEqual(Object.keys(events[0]).sort(), ["agent", "event", "run"]);
  }
});

test("wrong source account or role cannot issue target credentials", async () => {
  for (const Arn of ["arn:aws:sts::999999999999:assumed-role/fleet-worker-role/i-host", "arn:aws:sts::111111111111:assumed-role/operator/i-host"]) {
    const { deps, assumes } = fixture(); deps.identity = async () => ({ Account: "111111111111", Arn });
    await assert.rejects(authorizeTask("orders", deps)); assert.equal(assumes(), 0);
  }
});

test("wrong target account/role/session rejected after AssumeRole", async () => {
  for (const Arn of ["arn:aws:sts::999999999999:assumed-role/orders-read/s", "arn:aws:sts::222222222222:assumed-role/admin/s", "arn:aws:sts::222222222222:assumed-role/orders-read/wrong-session"]) {
    const { deps } = fixture(); const original = deps.identity;
    deps.identity = async (creds, region) => creds.accessKeyId === "source" ? original(creds, region) : { Account: "222222222222", Arn };
    await assert.rejects(authorizeTask("orders", deps));
  }
});

test("credential failures, expired source/target and IMDS extension never fall back", async () => {
  for (const mode of ["source-error", "expired-source", "extended-source", "assume-error", "expired-target", "no-token"]) {
    const { deps, events } = fixture();
    if (mode === "source-error") deps.source = async () => { throw new Error("secret-never-log"); };
    if (mode === "expired-source") deps.source = async () => ({ ...credentials(), expiration: new Date(0) });
    if (mode === "extended-source") deps.source = async () => ({ ...credentials(), originalExpiration: new Date(0) });
    if (mode === "assume-error") deps.assume = async () => { throw new Error("token-never-log"); };
    if (mode === "expired-target") deps.assume = async () => ({ ...credentials(), expiration: new Date(0) });
    if (mode === "no-token") deps.assume = async () => ({ ...credentials(), sessionToken: undefined });
    await assert.rejects(authorizeTask("orders", deps), /AWS access denied/);
    assert.equal(events.at(-1)?.event, "aws-access.denied");
    assert.ok(!JSON.stringify(events).includes("never-log"));
  }
});

test("grant removal while issuing fails closed and subsequent invocations cannot refresh", async () => {
  const { deps } = fixture(); const catalog = deps.readCatalog(); let reads = 0;
  deps.readCatalog = () => (++reads === 1 ? catalog : { ...catalog, targets: {} });
  await assert.rejects(authorizeTask("orders", deps));
  await assert.rejects(authorizeTask("orders", deps));
});

test("concurrent target tasks have separate credential context and unchanged parent env", async () => {
  const before = { ...process.env };
  const first = fixture(); const second = fixture();
  second.deps.readCatalog = () => RuntimeAwsAccess.parse({ ...agentAccessCatalog(fleet(), "worker"), targets: { other } });
  let session = "";
  second.deps.assume = async (_, _region, role, name) => { assert.equal(role, other.role_arn); session = name; return { ...credentials(), accessKeyId: "second-key" }; };
  const identity = second.deps.identity;
  second.deps.identity = async (creds, region) => creds.accessKeyId === "source" ? identity(creds, region) : { Account: other.account_id, Arn: `arn:aws:sts::333333333333:assumed-role/other-read/${session}` };
  const [a, b] = await Promise.all([authorizeTask("orders", first.deps), authorizeTask("other", second.deps)]);
  assert.notEqual(a.run, b.run);
  const [ea, eb] = [a, b].map(r => taskEnvironment(r.credentials, r.region, process.env));
  assert.notEqual(ea.AWS_ACCESS_KEY_ID, eb.AWS_ACCESS_KEY_ID);
  assert.deepEqual(await Promise.all([a, b].map(r => executeTask([process.execPath, "-e",
    `setTimeout(() => process.exit(process.env.AWS_ACCESS_KEY_ID === ${JSON.stringify(r.credentials.accessKeyId)} ? 0 : 2), 50)`], r.credentials, r.region))), [0, 0]);
  assert.ok(JSON.stringify({ ...process.env }) === JSON.stringify(before), "Parent environment changed");
});

test("clean child env suppresses all AWS/profile/endpoint and process overrides", () => {
  const env = cleanAccessEnvironment({ AWS_PROFILE: "operator", AWS_ROLE_ARN: "evil", AWS_ACCESS_KEY_ID: "operator-key",
    AWS_ENDPOINT_URL_STS: "https://evil", AWS_EC2_METADATA_SERVICE_ENDPOINT: "https://evil", AWS_CONFIG_FILE: "./evil", HOME: "/operator", NODE_OPTIONS: "--require evil", LD_PRELOAD: "evil", HOST_SERVICE_TOKEN: "secret" });
  assert.equal(env.AWS_CONFIG_FILE, "/dev/null"); assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, "/dev/null");
  assert.equal(env.AWS_EC2_METADATA_SERVICE_ENDPOINT, "http://169.254.169.254");
  for (const k of ["AWS_PROFILE", "AWS_ROLE_ARN", "AWS_ACCESS_KEY_ID", "AWS_ENDPOINT_URL_STS", "NODE_OPTIONS", "LD_PRELOAD", "HOST_SERVICE_TOKEN"]) assert.equal(env[k], undefined);
  assert.equal(taskEnvironment(credentials(), "us-west-2", {}).AWS_EC2_METADATA_DISABLED, "true");
});

test("actual child execution gets isolated credentials; failure cannot spawn; expiry kills child", async () => {
  const creds = credentials();
  assert.equal(await executeTask([process.execPath, "-e", 'process.exit(process.env.AWS_ACCESS_KEY_ID === "temporary-key" && process.env.AWS_EC2_METADATA_DISABLED === "true" ? 0 : 2)'], creds, "us-west-2"), 0);
  assert.equal(await executeTask([process.execPath, "-e", "process.exit(7)"], creds, "us-west-2"), 7);
  await assert.rejects(executeTask([process.execPath, "-e", "process.exit(0)"], { ...creds, expiration: new Date(0) }, "us-west-2"));
  assert.equal(await executeTask([process.execPath, "-e", "setTimeout(() => {}, 5000)"], { ...creds, expiration: new Date(Date.now() + 30_300) }, "us-west-2"), 124);
});

test("sync has independent binding, capability and clean root publication", () => {
  const host = { fleet: "fleet", agent: "worker", account_id: "111111111111", role_arn: sourceRole, region: "us-west-2" };
  const command = accessSyncCommand(agentAccessCatalog(fleet(), "worker"), "1.2.1", host, 1);
  for (const text of ["fleetmind aws-access capability", "fleetmind-aws-access-sync-v3", "fleetmind aws-access publish", "env -i", "fleetmind --version"]) assert.ok(command.includes(text));
  for (const text of ["workspace", "systemctl", "restart", "user_data"]) assert.ok(!command.includes(text));
  assert.ok(accessSyncCommand(null, "1.2.1", host, 1).includes("aws-access publish"));
  assert.throws(() => accessSyncCommand(null, "latest", host, 1));
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    assert.throws(() => accessSyncCommand(null, "1.2.1", host, revision as number));
  }
  const readme = fs.readFileSync("README.md", "utf8");
  assert.match(readme, /^## Scoped AWS application access$/m);
  assert.throws(() => accessSyncCommand(agentAccessCatalog(fleet(), "worker"), "1.2.1", { ...host, agent: "peer" }, 1));
});

test("static IAM nonreplacement regression: access touches independent exact-role policy only", () => {
  const policy = fs.readFileSync("infra/terraform/modules/fleetmind/aws-access.tf", "utf8");
  assert.match(policy, /resource "aws_iam_role_policy" "application_access"/);
  assert.match(policy, /role\s+= module.agent\[each.key\].iam_role_name/);
  assert.match(policy, /Action\s+= "sts:AssumeRole"/);
  assert.match(policy, /Resource = sort\(tolist\(each.value\)\)/);
  assert.doesNotMatch(policy, /resource "aws_instance"|user_data\s*=|rollout_trigger\s*=/);
  const main = fs.readFileSync("infra/terraform/modules/fleetmind/main.tf", "utf8");
  assert.ok(!main.includes("agent_aws_access_roles"));
  const targetPolicy = fs.readFileSync("examples/aws-application-access/target-role.tf", "utf8");
  assert.match(targetPolicy, /AWS = var.source_agent_role_arn/);
  assert.ok(!targetPolicy.includes('Action = "*"'));
  assert.ok(!targetPolicy.includes('Resource = "*"'));
});

test("CLI exposes executable task surface and never accepts catalog/role override", () => {
  const help = spawnSync(process.execPath, ["dist/cli/index.js", "aws-access", "exec", "--help"], { encoding: "utf8", env: cleanAccessEnvironment(process.env) });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /exec.*target.*command/);
  const bad = spawnSync(process.execPath, ["dist/cli/index.js", "aws-access", "exec", "unknown", "--", process.execPath, "-e", "process.exit(99)"], { encoding: "utf8", env: cleanAccessEnvironment(process.env), timeout: 10000 });
  assert.equal(bad.status, 1, bad.stderr);
  assert.ok(!bad.stderr.includes("temporary-key"));
});


test("fixed root catalog rejects writable files/directories and symlink traversal", t => {
  const config = agentAccessCatalog(fleet(), "worker")!;
  let directoryMode = 0o755;
  let uid = 0;
  let mode = 0o644;
  t.mock.method(fs, "lstatSync", () => ({ uid: 0, mode: directoryMode, isDirectory: () => true }));
  t.mock.method(fs, "openSync", (name: string, flags: number) => {
    assert.equal(name, "/etc/fleetmind/aws-access.json");
    assert.ok(flags & fs.constants.O_NOFOLLOW);
    return 42;
  });
  t.mock.method(fs, "fstatSync", () => ({ uid, mode, size: 100, isFile: () => true }));
  let publication: any = { version: 1, revision: 1, catalog: config };
  t.mock.method(fs, "readFileSync", () => JSON.stringify(publication));
  t.mock.method(fs, "closeSync", () => {});
  assert.deepEqual(readAccessCatalog(), config);
  publication = { version: 1, revision: 2, catalog: null };
  assert.throws(readAccessCatalog, /revoked/);
  publication = config; assert.throws(readAccessCatalog, "legacy unrevisioned catalogs fail closed");
  publication = { version: 1, revision: 0, catalog: config }; assert.throws(readAccessCatalog);
  publication = { version: 1, revision: 1, catalog: config };
  uid = 1000; assert.throws(readAccessCatalog, /Untrusted AWS access catalog/);
  uid = 0; mode = 0o664; assert.throws(readAccessCatalog, /Untrusted AWS access catalog/);
  mode = 0o644; directoryMode = 0o775; assert.throws(readAccessCatalog, /Untrusted AWS access directory/);
  directoryMode = 0o755;
  t.mock.method(fs, "lstatSync", () => ({ uid: 0, mode: 0o755, isDirectory: () => false }));
  assert.throws(readAccessCatalog, /Untrusted AWS access directory/);
});
