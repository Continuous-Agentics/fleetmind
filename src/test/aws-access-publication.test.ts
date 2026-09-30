import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STSClient } from "@aws-sdk/client-sts";
import { publishAccess } from "../runtime/aws-access-publication.js";
import { RuntimeAwsAccess } from "../config/aws-access.js";

const host = { fleet: "fleet", agent: "worker", account_id: "111111111111", role_arn: "arn:aws:iam::111111111111:role/fleet-worker-role", region: "us-west-2" };
const catalog = RuntimeAwsAccess.parse({ version: 1, agent: host.agent, source_role_arn: host.role_arn, source_region: host.region, targets: { orders: { app: "orders", environment: "staging", access: "read", account_id: "222222222222", role_arn: "arn:aws:iam::222222222222:role/orders", region: "us-west-2" } } });

test("SF1/MF2: actual filesystem publication is atomic, no-op, serialized and independently host-authorized", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fm-publication-"));
  fs.chmodSync(directory, 0o755);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envFile = path.join(directory, "agent.env");
  fs.writeFileSync(envFile, "FLEET_NAME=fleet\nAGENT_ID=worker\n", { mode: 0o644 });
  const file = path.join(directory, "aws-access.json");
  let identity = "arn:aws:sts::111111111111:assumed-role/fleet-worker-role/i-abc";
  let calls = 0;
  t.mock.method(STSClient.prototype, "send", async () => { calls++; return { Account: "111111111111", Arn: identity }; });
  const options = { directory, ownerUid: process.getuid!(), source: async () => ({ accessKeyId: "synthetic", secretAccessKey: "synthetic", sessionToken: "synthetic", expiration: new Date(Date.now() + 900_000) }) };
  assert.equal(await publishAccess(catalog, host, 1, options), "published");
  const inode = fs.statSync(file).ino;
  const contents = fs.readFileSync(file, "utf8");
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.equal(await publishAccess(catalog, host, 1, options), "unchanged");
  assert.equal(fs.statSync(file).ino, inode);
  // Rename hook observes real complete old/new bytes immediately around actual rename.
  const rename = fs.renameSync;
  let renames = 0;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (fs.existsSync(to) && !fs.lstatSync(to).isSymbolicLink()) assert.doesNotThrow(() => JSON.parse(fs.readFileSync(to, "utf8")));
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(from, "utf8")));
    rename(from, to); renames++;
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(to, "utf8")));
  });
  const changed = structuredClone(catalog); changed.targets.orders.access = "changed";
  assert.equal(await publishAccess(changed, host, 2, options), "published");
  assert.notEqual(fs.statSync(file).ino, inode);
  assert.equal(renames, 1);
  const results = await Promise.all(Array.from({ length: 8 }, () => publishAccess(catalog, host, 3, options)));
  assert.equal(results.filter(x => x === "published").length, 1);
  assert.equal(results.filter(x => x === "unchanged").length, 7);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).catalog, JSON.parse(contents).catalog);
  assert.deepEqual(fs.readdirSync(directory).sort(), ["agent.env", "aws-access.json"]);
  for (const revoke of [false, true]) {
    identity = "arn:aws:sts::111111111111:assumed-role/wrong-role/i-abc";
    await assert.rejects(publishAccess(revoke ? null : catalog, host, 3, options));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).catalog, JSON.parse(contents).catalog);
  }
  identity = "arn:aws:sts::111111111111:assumed-role/fleet-worker-role/i-abc";
  for (const text of ["FLEET_NAME=fleet\nAGENT_ID=peer\n", "FLEET_NAME=fleet\nAGENT_ID=worker\nAGENT_ID=worker\n"]) {
    fs.writeFileSync(envFile, text); const before = calls;
    await assert.rejects(publishAccess(null, host, 4, options)); assert.equal(calls, before);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).catalog, JSON.parse(contents).catalog);
  }
  fs.writeFileSync(envFile, "FLEET_NAME=fleet\nAGENT_ID=worker\n");
  fs.chmodSync(envFile, 0o666);
  await assert.rejects(publishAccess(null, host, 4, options)); fs.chmodSync(envFile, 0o644);
  await assert.rejects(publishAccess({ ...catalog, source_role_arn: host.role_arn + "-evil" }, host, 3, options));
  await assert.rejects(publishAccess({ ...catalog, agent: "peer" }, host, 3, options));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).catalog, JSON.parse(contents).catalog);
  await assert.rejects(publishAccess(false as any, host, 3, options));
  await assert.rejects(publishAccess(undefined as any, host, 3, options));
  // Untrusted state is never replaced: doing so would lose its high-water mark.
  const victim = path.join(directory, "victim"); fs.writeFileSync(victim, "unchanged");
  fs.unlinkSync(file); fs.symlinkSync(victim, file);
  await assert.rejects(publishAccess(catalog, host, 4, options));
  assert.equal(fs.readFileSync(victim, "utf8"), "unchanged"); assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  fs.unlinkSync(file); fs.writeFileSync(file, contents);
  assert.equal(await publishAccess(null, host, 4, options), "removed"); assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).catalog, null);
  assert.equal(await publishAccess(null, host, 4, options), "removed");
  fs.mkdirSync(path.join(directory, ".aws-access.lock"));
  await assert.rejects(publishAccess(catalog, host, 5, { ...options, lockTimeoutMs: 20 }), /lock unavailable/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).catalog, null);
});
