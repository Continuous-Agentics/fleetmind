/**
 * Tests for the local-fs ArtifactStore. The store is what makes the `local`
 * deploy path go through the same pipeline as remote, so its key/prefix
 * semantics need to match what the transport mechanics (lock, history) expect.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalFsArtifactStore } from "../deploy/local.js";

describe("LocalFsArtifactStore", () => {
  let root: string;
  let store: LocalFsArtifactStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-localfs-"));
    store = new LocalFsArtifactStore(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("put then get round-trips, and creates nested dirs", async () => {
    await store.put("deploy-staging/conductor.tar.gz", Buffer.from("bundle"));
    const got = await store.get("deploy-staging/conductor.tar.gz");
    assert.equal(got?.toString(), "bundle");
    assert.ok(fs.existsSync(path.join(root, "deploy-staging", "conductor.tar.gz")));
  });

  it("get returns null for a missing key", async () => {
    assert.equal(await store.get("deploy-staging/missing.tar.gz"), null);
  });

  it("copy duplicates an object; throws on missing source", async () => {
    await store.put("deploy-staging/a.tar.gz", Buffer.from("x"));
    await store.copy("deploy-staging/a.tar.gz", "deploy-staging/history/a/2026-b.tar.gz");
    assert.equal((await store.get("deploy-staging/history/a/2026-b.tar.gz"))?.toString(), "x");
    await assert.rejects(() => store.copy("nope", "dest"), /NoSuchKey/);
  });

  it("list returns forward-slash keys under a prefix, sorted", async () => {
    await store.put("deploy-staging/history/c/2.tar.gz", Buffer.from("2"));
    await store.put("deploy-staging/history/c/1.tar.gz", Buffer.from("1"));
    await store.put("deploy-staging/other.tar.gz", Buffer.from("o"));
    const keys = await store.list("deploy-staging/history/c/");
    assert.deepEqual(keys, [
      "deploy-staging/history/c/1.tar.gz",
      "deploy-staging/history/c/2.tar.gz",
    ]);
  });

  it("delete removes an object and is a no-op when absent", async () => {
    await store.put("deploy-staging/x.tar.gz", Buffer.from("x"));
    await store.delete("deploy-staging/x.tar.gz");
    assert.equal(await store.get("deploy-staging/x.tar.gz"), null);
    await assert.doesNotReject(() => store.delete("deploy-staging/x.tar.gz"));
  });

  it("works as a drop-in for the transport lock + history mechanics", async () => {
    // Sanity: the generic lock/history (tested elsewhere over an in-memory
    // store) operate purely through put/get/copy/list/delete, which this store
    // satisfies — exercise a representative sequence.
    await store.put("deploy-staging/lock.json", Buffer.from("{}"));
    assert.ok(await store.get("deploy-staging/lock.json"));
    await store.delete("deploy-staging/lock.json");
    assert.equal(await store.get("deploy-staging/lock.json"), null);
  });
});
