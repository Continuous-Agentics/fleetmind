import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STSClient } from "@aws-sdk/client-sts";
import { publishAccess } from "../runtime/aws-access-publication.js";
import { RuntimeAwsAccess } from "../config/aws-access.js";

test("MF4: actual publication and revocation sync the directory, no-ops do not, and failures reject", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fm-revocation-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "agent.env"), "FLEET_NAME=fleet\nAGENT_ID=worker\n", { mode: 0o644 });
  const file = path.join(directory, "aws-access.json");
  const lock = path.join(directory, ".aws-access.lock");
  const host = { fleet: "fleet", agent: "worker", account_id: "111111111111", role_arn: "arn:aws:iam::111111111111:role/fleet-worker-role", region: "us-west-2" };
  const catalog = RuntimeAwsAccess.parse({ version: 1, agent: host.agent, source_role_arn: host.role_arn, source_region: host.region, targets: { orders: { app: "orders", environment: "staging", access: "read", account_id: "222222222222", role_arn: "arn:aws:iam::222222222222:role/orders", region: "us-west-2" } } });
  t.mock.method(STSClient.prototype, "send", async () => ({ Account: host.account_id, Arn: "arn:aws:sts::111111111111:assumed-role/fleet-worker-role/i-abc" }));
  const options = { directory, ownerUid: process.getuid!(), source: async () => ({ accessKeyId: "synthetic", secretAccessKey: "synthetic", sessionToken: "synthetic", expiration: new Date(Date.now() + 900_000) }) };
  const sync = fs.fsyncSync;
  const events: string[] = [];
  const syncError = new Error("synthetic directory sync failure");
  let failSync = false;
  t.mock.method(fs, "fsyncSync", (fd: number) => {
    const stat = fs.fstatSync(fd);
    if (stat.isDirectory()) {
      assert.equal(stat.ino, fs.statSync(directory).ino);
      assert.equal(stat.dev, fs.statSync(directory).dev);
      assert.ok(fs.existsSync(lock), "keep publication lock through directory sync");
      events.push(fs.existsSync(file) ? "directory:published" : "directory:removed");
      if (failSync) throw syncError;
    } else events.push("file");
    sync(fd);
  });
  assert.equal(await publishAccess(catalog, host, options), "published");
  assert.deepEqual(events.splice(0), ["file", "directory:published"]);
  assert.equal(await publishAccess(catalog, host, options), "unchanged");
  assert.deepEqual(events, []);
  assert.equal(await publishAccess(null, host, options), "removed");
  assert.deepEqual(events.splice(0), ["directory:removed"]);
  assert.equal(fs.existsSync(file), false);
  assert.equal(await publishAccess(null, host, options), "removed");
  assert.deepEqual(events, [], "already absent remains a no-op");

  await publishAccess(catalog, host, options); events.length = 0;
  failSync = true;
  await assert.rejects(publishAccess(null, host, options), error => error === syncError);
  assert.deepEqual(events.splice(0), ["directory:removed"]);
  assert.equal(fs.existsSync(file), false, "unlink happened but failed durability must not report success");
  assert.equal(fs.existsSync(lock), false, "release owned lock on sync failure");
  failSync = false;
  assert.equal(await publishAccess(catalog, host, options), "published", "failure does not strand the lock");

  const unlink = fs.unlinkSync;
  const cleanupError = new Error("synthetic temporary cleanup failure");
  t.mock.method(fs, "unlinkSync", (name: fs.PathLike) => {
    if (path.basename(String(name)).startsWith(".aws-access.")) throw cleanupError;
    unlink(name);
  });
  await assert.rejects(publishAccess(null, host, options), error => error === cleanupError);
  assert.equal(fs.existsSync(lock), false, "cleanup failure still releases owned lock");
});
