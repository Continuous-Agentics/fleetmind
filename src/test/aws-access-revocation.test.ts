import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STSClient } from "@aws-sdk/client-sts";
import { readAccessCatalog, authorizeTask } from "../runtime/aws-access.js";
import { publishAccess } from "../runtime/aws-access-publication.js";
import { AwsAccessPublication, RuntimeAwsAccess } from "../config/aws-access.js";

const host = { fleet: "fleet", agent: "worker", account_id: "111111111111", role_arn: "arn:aws:iam::111111111111:role/fleet-worker-role", region: "us-west-2" };
const catalog = RuntimeAwsAccess.parse({ version: 1, agent: host.agent, source_role_arn: host.role_arn, source_region: host.region, targets: { orders: { app: "orders", environment: "staging", access: "read", account_id: "222222222222", role_arn: "arn:aws:iam::222222222222:role/orders", region: "us-west-2" } } });
function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fm-revocation-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "agent.env"), "FLEET_NAME=fleet\nAGENT_ID=worker\n", { mode: 0o644 });
  t.mock.method(STSClient.prototype, "send", async () => ({ Account: host.account_id, Arn: "arn:aws:sts::111111111111:assumed-role/fleet-worker-role/i-abc" }));
  const options = { directory, ownerUid: process.getuid!(), source: async () => ({ accessKeyId: "synthetic", secretAccessKey: "synthetic", sessionToken: "synthetic", expiration: new Date(Date.now() + 900_000) }) };
  const file = path.join(directory, "aws-access.json");
  const state = () => AwsAccessPublication.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  return { directory, options, file, state, lock: path.join(directory, ".aws-access.lock") };
}

test("publication and revocation retries prove directory durability after failed fsync", async t => {
  const { directory, options, file, state, lock } = fixture(t);
  const sync = fs.fsyncSync;
  const events: string[] = [];
  const syncError = new Error("synthetic directory sync failure");
  let failSync = true;
  t.mock.method(fs, "fsyncSync", (fd: number) => {
    const stat = fs.fstatSync(fd);
    if (stat.isDirectory()) {
      assert.equal(stat.ino, fs.statSync(directory).ino);
      assert.equal(stat.dev, fs.statSync(directory).dev);
      assert.ok(fs.existsSync(lock), "keep publication lock through directory sync");
      events.push(state().catalog === null ? "directory:revoked" : "directory:published");
      if (failSync) throw syncError;
    } else events.push("file");
    sync(fd);
  });
  for (const [revision, desired, result, event] of [[1, catalog, "unchanged", "directory:published"], [2, null, "removed", "directory:revoked"]] as const) {
    failSync = true;
    await assert.rejects(publishAccess(desired, host, revision, options), error => error === syncError);
    assert.deepEqual(events.splice(0), ["file", event]);
    assert.equal(fs.existsSync(lock), false, "failure releases owned lock");
    assert.equal(state().revision, revision, "rename occurred before failed barrier");
    const inode = fs.statSync(file).ino;
    await assert.rejects(publishAccess(desired, host, revision, options), error => error === syncError);
    assert.deepEqual(events.splice(0), [event], "failed retry must not report success");
    failSync = false;
    assert.equal(await publishAccess(desired, host, revision, options), result);
    assert.deepEqual(events.splice(0), [event], "successful retry must sync directory");
    assert.equal(fs.statSync(file).ino, inode, "identical retry keeps inode");
    assert.deepEqual(state().catalog, desired);
  }
  const unlink = fs.unlinkSync;
  const cleanupError = new Error("synthetic temporary cleanup failure");
  t.mock.method(fs, "unlinkSync", (name: fs.PathLike) => {
    if (path.basename(String(name)).startsWith(".aws-access.")) throw cleanupError;
    unlink(name);
  });
  await assert.rejects(publishAccess(null, host, 2, options), error => error === cleanupError);
  assert.equal(fs.existsSync(lock), false, "cleanup failure still releases owned lock");
});

test("monotonic publication rejects delayed grants, conflicting retries and invalid state", async t => {
  const { options, file, state } = fixture(t);
  assert.equal(await publishAccess(catalog, host, 1, options), "published");
  assert.equal(await publishAccess(null, host, 3, options), "removed");
  const tombstone = fs.readFileSync(file, "utf8");
  for (const revision of [1, 2]) {
    await assert.rejects(publishAccess(catalog, host, revision, options), /Stale/);
    assert.equal(fs.readFileSync(file, "utf8"), tombstone);
  }
  await assert.rejects(publishAccess(catalog, host, 3, options), /Conflicting/);
  assert.equal(await publishAccess(null, host, 3, options), "removed");
  assert.equal(state().catalog, null);
  assert.equal(await publishAccess(catalog, host, 4, options), "published", "explicit newer desired state may regrant");
  const changed = structuredClone(catalog); changed.targets.orders.access = "changed";
  await assert.rejects(publishAccess(changed, host, 4, options), /Conflicting/);
  const delivered = await Promise.allSettled([
    publishAccess(null, host, 6, options), publishAccess(catalog, host, 5, options),
  ]);
  assert.equal(delivered[0].status, "fulfilled");
  assert.equal(delivered[1].status, "rejected");
  assert.equal(state().revision, 6); assert.equal(state().catalog, null);
  // Revision validation precedes credentials/identity calls, not just file writes.
  const neverSource = { ...options, source: async () => { assert.fail("invalid revision consulted credentials"); } };
  for (const revision of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, "7"]) {
    await assert.rejects(publishAccess(catalog, host, revision as number, neverSource));
  }
  for (const contents of ["not JSON", JSON.stringify(catalog), JSON.stringify({ version: 1, revision: 0, catalog: null })]) {
    fs.writeFileSync(file, contents);
    await assert.rejects(publishAccess(catalog, host, 7, options));
    assert.equal(fs.readFileSync(file, "utf8"), contents, "never erase an unknown high-water mark");
  }
});

test("failure before rename preserves revision; failed revocation barrier still rejects stale delivery", async t => {
  const { options, file, state, lock } = fixture(t);
  await publishAccess(catalog, host, 1, options);
  const before = fs.readFileSync(file, "utf8");
  const failure = new Error("synthetic rename failure");
  const renameMock = t.mock.method(fs, "renameSync", () => { throw failure; });
  await assert.rejects(publishAccess(null, host, 2, options), error => error === failure);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(fs.existsSync(lock), false);
  renameMock.mock.restore();
  const sync = fs.fsyncSync;
  const syncMock = t.mock.method(fs, "fsyncSync", (fd: number) => { if (fs.fstatSync(fd).isDirectory()) throw failure; sync(fd); });
  await assert.rejects(publishAccess(null, host, 2, options), error => error === failure);
  assert.equal(state().revision, 2); assert.equal(state().catalog, null);
  await assert.rejects(publishAccess(catalog, host, 1, options), /Stale/);
  assert.equal(state().catalog, null);
  syncMock.mock.restore();
  assert.equal(await publishAccess(null, host, 2, options), "removed");
});


test("real publication bytes flow through the fixed-path reader and tombstones deny before credentials", async t => {
  const { options, file } = fixture(t);
  await publishAccess(catalog, host, 1, options);
  const grant = fs.readFileSync(file, "utf8");
  await publishAccess(null, host, 2, options);
  const tombstone = fs.readFileSync(file, "utf8");
  // Redirect only the fixed production reader's filesystem boundary; bytes come
  // from actual authorized/atomic publications, not independently built fixtures.
  t.mock.method(fs, "lstatSync", () => ({ uid: 0, mode: 0o755, isDirectory: () => true }));
  t.mock.method(fs, "openSync", (name: string, flags: number) => {
    assert.equal(name, "/etc/fleetmind/aws-access.json");
    assert.ok(flags & fs.constants.O_NOFOLLOW); return 42;
  });
  t.mock.method(fs, "fstatSync", () => ({ uid: 0, mode: 0o644, size: Buffer.byteLength(grant), isFile: () => true }));
  let contents = grant;
  t.mock.method(fs, "readFileSync", () => contents);
  t.mock.method(fs, "closeSync", () => {});
  assert.deepEqual(readAccessCatalog(), catalog);
  contents = tombstone;
  assert.throws(readAccessCatalog, /revoked/);
  await assert.rejects(authorizeTask("orders", {
    readCatalog: readAccessCatalog,
    source: async () => { assert.fail("revoked state must not retrieve credentials"); },
    identity: async () => { assert.fail("revoked state must not call STS"); },
    assume: async () => { assert.fail("revoked state must not assume a role"); },
    audit: e => assert.equal(e.event, "aws-access.denied"), now: Date.now,
  }), /AWS access denied/);
});
