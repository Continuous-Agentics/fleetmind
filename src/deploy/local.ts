/**
 * Local adapters for the deploy transport contracts — the single-host path
 * (operator machine == agent host), e.g. a Mac mini or a dev MacBook.
 *
 * The artifact store is a directory on disk; resolving a host is trivial (it's
 * this machine); running a command is a local shell exec. With these, a
 * `local` target runs the exact same deploy pipeline as a remote one — render,
 * stage to the store, run `fleetmind pull-self --apply` — just without a
 * network in between.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ArtifactStore, TargetResolver, CommandRunner } from "./transport.js";

/** Default root for the local artifact store. */
export function defaultLocalStoreRoot(): string {
  return path.join(process.env.HOME ?? process.cwd(), ".fleetmind", "store");
}

/** Filesystem-backed ArtifactStore rooted at a directory. Keys are
 *  forward-slash relative paths under the root (mirroring S3 key shape). */
export class LocalFsArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  private full(key: string): string {
    return path.join(this.root, key);
  }

  async put(key: string, body: Buffer): Promise<void> {
    const p = this.full(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }

  async get(key: string): Promise<Buffer | null> {
    const p = this.full(key);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }

  async copy(srcKey: string, destKey: string): Promise<void> {
    const s = this.full(srcKey);
    if (!fs.existsSync(s)) throw new Error(`NoSuchKey: ${srcKey}`);
    const d = this.full(destKey);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(s, d);
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
        } else {
          keys.push(path.relative(this.root, abs).split(path.sep).join("/"));
        }
      }
    };
    walk(this.root);
    return keys.filter((k) => k.startsWith(prefix)).sort((a, b) => a.localeCompare(b));
  }

  async delete(key: string): Promise<void> {
    const p = this.full(key);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

/** The host is this machine. */
export class LocalTargetResolver implements TargetResolver {
  async resolveHost(_agentId: string): Promise<string | null> {
    return "local";
  }
}

/** Runs commands in a local shell, sequenced with `&&` (same fail-fast
 *  semantics as the remote SSM path). */
export class LocalCommandRunner implements CommandRunner {
  async run(_hostHandle: string, commands: string[]): Promise<string> {
    execFileSync("sh", ["-c", commands.join(" && ")], { stdio: "inherit" });
    return "local";
  }
}
