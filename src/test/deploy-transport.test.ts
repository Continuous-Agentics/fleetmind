/**
 * Tests for the provider-neutral deploy-transport mechanics (lock + history),
 * exercised against an in-memory ArtifactStore. These behaviors used to live
 * inside push-fleet hard-wired to the S3 SDK; here they're tested once, store-
 * agnostically.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  acquireDeployLock,
  releaseDeployLock,
  archiveToHistory,
  listHistory,
  type ArtifactStore,
} from "../deploy/transport.js";
import { agentArtifactKeys, DEPLOY_LOCK_KEY, HISTORY_MAX } from "../deploy/plan.js";

/** Minimal in-memory ArtifactStore for tests. */
class MemoryArtifactStore implements ArtifactStore {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer): Promise<void> {
    this.objects.set(key, body);
  }
  async get(key: string): Promise<Buffer | null> {
    return this.objects.get(key) ?? null;
  }
  async copy(srcKey: string, destKey: string): Promise<void> {
    const b = this.objects.get(srcKey);
    if (!b) throw new Error(`NoSuchKey: ${srcKey}`);
    this.objects.set(destKey, b);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

function lockJson(ageSeconds: number, holder = "someone-else@host"): Buffer {
  return Buffer.from(
    JSON.stringify({
      acquired_at: new Date(Date.now() - ageSeconds * 1000).toISOString(),
      holder,
      ttl_seconds: 300,
    })
  );
}

describe("deploy lock", () => {
  let store: MemoryArtifactStore;
  beforeEach(() => {
    store = new MemoryArtifactStore();
  });

  it("acquires when no lock exists", async () => {
    await acquireDeployLock(store, DEPLOY_LOCK_KEY);
    assert.ok(await store.get(DEPLOY_LOCK_KEY), "lock object should be written");
  });

  it("throws when a live lock is held by someone else", async () => {
    await store.put(DEPLOY_LOCK_KEY, lockJson(10));
    await assert.rejects(() => acquireDeployLock(store, DEPLOY_LOCK_KEY), /locked by someone-else/);
  });

  it("overrides a stale (expired) lock", async () => {
    await store.put(DEPLOY_LOCK_KEY, lockJson(400)); // age 400s > ttl 300s
    await acquireDeployLock(store, DEPLOY_LOCK_KEY); // should not throw
    const raw = await store.get(DEPLOY_LOCK_KEY);
    assert.ok(raw && !raw.toString().includes("someone-else"), "lock should be taken over");
  });

  it("release deletes the lock", async () => {
    await acquireDeployLock(store, DEPLOY_LOCK_KEY);
    await releaseDeployLock(store, DEPLOY_LOCK_KEY);
    assert.equal(await store.get(DEPLOY_LOCK_KEY), null);
  });
});

describe("history", () => {
  let store: MemoryArtifactStore;
  const agentId = "conductor";
  const keys = agentArtifactKeys(agentId);

  beforeEach(() => {
    store = new MemoryArtifactStore();
  });

  it("archives the current bundle (tarball + manifest) into history", async () => {
    await store.put(keys.tarball, Buffer.from("tarball-v1"));
    await store.put(keys.manifest, Buffer.from("{}"));

    await archiveToHistory(store, agentId, "abcdef1234567890");

    const inHistory = await store.list(keys.historyPrefix);
    assert.equal(inHistory.filter((k) => k.endsWith(".tar.gz")).length, 1);
    assert.equal(inHistory.filter((k) => k.endsWith(".manifest.json")).length, 1);

    const entries = await listHistory(store, agentId);
    assert.equal(entries.length, 1);
    assert.ok(entries[0]!.key.includes("abcdef12"), "history key embeds the sha prefix");
  });

  it("is best-effort: a fresh agent with no current bundle does not throw", async () => {
    await archiveToHistory(store, agentId, "deadbeefdeadbeef");
    assert.deepEqual(await listHistory(store, agentId), []);
  });

  it("prunes to the most recent HISTORY_MAX entries", async () => {
    // Pre-seed more than HISTORY_MAX history tarballs.
    for (let i = 0; i < HISTORY_MAX + 3; i++) {
      await store.put(`${keys.historyPrefix}2026-01-01-00-0${i}-00-000Z-sha${i}.tar.gz`, Buffer.from("x"));
    }
    await store.put(keys.tarball, Buffer.from("current"));
    await store.put(keys.manifest, Buffer.from("{}"));

    await archiveToHistory(store, agentId, "feedface00000000");

    const tarballs = (await store.list(keys.historyPrefix)).filter((k) => k.endsWith(".tar.gz"));
    assert.equal(tarballs.length, HISTORY_MAX, "history should be pruned to HISTORY_MAX tarballs");
  });

  it("lists history newest-first", async () => {
    await store.put(`${keys.historyPrefix}2026-01-01-00-00-00-000Z-aaa.tar.gz`, Buffer.from("x"));
    await store.put(`${keys.historyPrefix}2026-02-01-00-00-00-000Z-bbb.tar.gz`, Buffer.from("x"));
    const entries = await listHistory(store, agentId);
    assert.ok(entries[0]!.key.includes("2026-02-01"), "newest entry first");
    assert.ok(entries[1]!.key.includes("2026-01-01"));
  });
});
