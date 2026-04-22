/**
 * FleetMind watcher — GitOps skills watcher.
 *
 * Polls a versioned skills repo for changes and pushes updates to agent workspaces.
 */

import fs from "node:fs";
import path from "node:path";
import type { Fleet, AgentConfig } from "../config/schema.js";
import { log } from "../utils/log.js";

export interface SkillUpdate {
  agentId: string;
  skillName: string;
  oldVersion: string | undefined;
  newVersion: string;
  pinned: boolean;
}

const CACHE_DIR = path.join(process.env.HOME ?? "/tmp", ".fleetmind", "skills-cache");

export class SkillsWatcher {
  constructor(private fleet: Fleet) {}

  /** Fetch versions.json from the skills repo. Returns { skillName: version }. */
  async fetchVersions(): Promise<Record<string, string>> {
    const repo = this.fleet.skills_repo;

    // Local mode — read directly
    if (repo.local) {
      const vFile = path.resolve(repo.local, "versions.json");
      if (fs.existsSync(vFile)) {
        return JSON.parse(fs.readFileSync(vFile, "utf-8"));
      }
      return {};
    }

    // Remote mode — clone or pull
    if (!repo.url) return {};

    try {
      const { simpleGit } = await import("simple-git");
      const git = simpleGit();

      if (fs.existsSync(CACHE_DIR)) {
        await simpleGit(CACHE_DIR).pull();
      } else {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        await git.clone(repo.url, CACHE_DIR, ["--branch", repo.branch ?? "main"]);
      }

      const vFile = path.join(CACHE_DIR, "versions.json");
      if (fs.existsSync(vFile)) {
        return JSON.parse(fs.readFileSync(vFile, "utf-8"));
      }
    } catch (err) {
      log.warn(`Error fetching skills repo: ${String(err)}`);
    }

    return {};
  }

  /** Get installed skill versions for an agent by reading package.json files. */
  getInstalledVersions(agentId: string): Record<string, string> {
    const workspace = path.join(
      this.fleet.agents.defaults.workspace_base,
      `workspace-${agentId}`
    );
    const skillsDir = path.join(workspace, "skills");
    if (!fs.existsSync(skillsDir)) return {};

    const versions: Record<string, string> = {};
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgFile = path.join(skillsDir, entry.name, "package.json");
      if (fs.existsSync(pkgFile)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf-8"));
          versions[entry.name] = pkg.version ?? "unknown";
        } catch {
          versions[entry.name] = "unknown";
        }
      }
    }
    return versions;
  }

  /** Compare installed vs available versions for an agent. Respects pins. */
  diff(agentId: string, available: Record<string, string>): SkillUpdate[] {
    const agent = this.fleet.getAgent(agentId);
    if (!agent) return [];

    const installed = this.getInstalledVersions(agentId);
    const updates: SkillUpdate[] = [];

    for (const skillRef of agent.skills) {
      const { name, version: pin } = skillRef;
      const current = installed[name];
      const latest = available[name];
      if (!latest) continue;

      if (pin) {
        // Pinned — flag but don't auto-update
        if (current !== pin) {
          updates.push({ agentId, skillName: name, oldVersion: current, newVersion: pin, pinned: true });
        }
      } else {
        // Unpinned — update to latest
        if (current !== latest) {
          updates.push({ agentId, skillName: name, oldVersion: current, newVersion: latest, pinned: false });
        }
      }
    }

    return updates;
  }

  /** Push a skill to an agent workspace. */
  pushSkill(agentId: string, skillName: string): boolean {
    const agent = this.fleet.getAgent(agentId);
    if (!agent) {
      log.error(`Agent ${agentId} not found`);
      return false;
    }

    const workspace = path.join(
      this.fleet.agents.defaults.workspace_base,
      `workspace-${agentId}`
    );
    const dest = path.join(workspace, "skills", skillName);
    const src = this.findSkillSource(skillName);

    if (!src) {
      log.error(`Skill ${skillName} not found`);
      return false;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
    fs.cpSync(src, dest, { recursive: true });

    log.ok(`Pushed ${skillName} to ${agentId}`);
    return true;
  }

  private findSkillSource(skillName: string): string | undefined {
    const candidates: string[] = [];
    if (this.fleet.skills_repo.local) {
      candidates.push(path.resolve(this.fleet.skills_repo.local, skillName));
    }
    candidates.push(path.resolve("./skills", skillName));
    if (fs.existsSync(CACHE_DIR)) {
      candidates.push(path.join(CACHE_DIR, skillName));
    }
    return candidates.find((c) => fs.existsSync(c));
  }

  private parsePollInterval(): number {
    const s = this.fleet.skills_repo.poll_interval ?? "60s";
    if (s.endsWith("h")) return parseInt(s) * 3600 * 1000;
    if (s.endsWith("m")) return parseInt(s) * 60 * 1000;
    return parseInt(s) * 1000;
  }

  /** Start the polling watch loop. Runs until SIGINT. */
  async watch(onUpdate?: (update: SkillUpdate) => void): Promise<void> {
    const interval = this.parsePollInterval();
    log.info(`FleetMind Watch — polling every ${this.fleet.skills_repo.poll_interval}`);
    log.info(`  Skills repo: ${this.fleet.skills_repo.url || this.fleet.skills_repo.local || "(none)"}`);
    log.info("  Press Ctrl+C to stop.\n");

    const tick = async () => {
      const available = await this.fetchVersions();
      const keys = Object.keys(available);
      if (keys.length > 0) {
        log.dim(`Available: ${keys.map((k) => `${k}@${available[k]}`).join(", ")}`);
      } else {
        log.dim("No versions.json found in skills repo.");
      }

      for (const agent of this.fleet.agents.list) {
        const updates = this.diff(agent.id, available);
        for (const u of updates) {
          if (u.pinned) {
            log.warn(`↔ ${agent.emoji} ${agent.name}: ${u.skillName} pinned@${u.newVersion} (installed: ${u.oldVersion ?? "none"}) — skipping`);
          } else {
            log.info(`↑ ${agent.emoji} ${agent.name}: ${u.skillName} ${u.oldVersion ?? "none"} → ${u.newVersion}`);
            this.pushSkill(agent.id, u.skillName);
            onUpdate?.(u);
          }
        }
      }
    };

    await tick();

    return new Promise((resolve) => {
      const timer = setInterval(async () => {
        try { await tick(); } catch (e) { log.error(String(e)); }
      }, interval);

      process.on("SIGINT", () => {
        clearInterval(timer);
        log.dim("\nWatcher stopped.");
        resolve();
      });
    });
  }
}
