/**
 * FleetMind skill resolver — three-tier skill source resolution.
 *
 * Tier 1: clawhub  — public skills on ClaWHub (fetched from GitHub public repos)
 * Tier 2: private  — Continuous Agentics proprietary library (GitHub Packages / npm private)
 * Tier 3: client   — skills in the client's own skills_repo (default)
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { Fleet, SkillRef, PrivateRegistry } from "../config/schema.js";
import { log } from "../utils/log.js";

const CACHE_BASE = path.join(process.env.HOME ?? "/tmp", ".fleetmind", "skill-cache");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cacheDir(tier: string, name: string): string {
  return path.join(CACHE_BASE, tier, name);
}

function ensureCache(): void {
  fs.mkdirSync(CACHE_BASE, { recursive: true });
}

// ---------------------------------------------------------------------------
// Tier 1: ClaWHub (public GitHub repos)
// ---------------------------------------------------------------------------

/**
 * ClaWHub skills are published as public GitHub repos under a known author.
 * Convention: github.com/<author>/<name> or github.com/<author>/skills (monorepo).
 *
 * Resolution order:
 *   1. github.com/<author>/<name>  (dedicated skill repo)
 *   2. github.com/<author>/skills/<name>  (monorepo subdirectory)
 */
async function resolveClawHub(skill: SkillRef): Promise<string | undefined> {
  const author = skill.author;
  if (!author) {
    log.error(`  Skill ${skill.name}: source=clawhub requires an "author" field`);
    return undefined;
  }

  ensureCache();
  const dest = cacheDir("clawhub", `${author}__${skill.name}`);
  const ref = skill.version ? `--branch ${skill.version}` : "";

  // Try dedicated repo first
  const repoUrl = `https://github.com/${author}/${skill.name}.git`;
  try {
    if (fs.existsSync(dest)) {
      log.dim(`  [clawhub] Updating ${skill.name} from ${repoUrl}`);
      execSync(`git -C ${dest} pull --quiet`, { stdio: "pipe" });
    } else {
      log.dim(`  [clawhub] Cloning ${skill.name} from ${repoUrl}`);
      execSync(`git clone --quiet --depth 1 ${ref} ${repoUrl} ${dest}`, { stdio: "pipe" });
    }
    return dest;
  } catch {
    // fall through to monorepo attempt
  }

  // Try monorepo: github.com/<author>/skills/<name>
  const monoCache = cacheDir("clawhub", `${author}__skills-mono`);
  const monoUrl = `https://github.com/${author}/skills.git`;
  try {
    if (fs.existsSync(monoCache)) {
      log.dim(`  [clawhub] Updating skills monorepo for ${author}`);
      execSync(`git -C ${monoCache} pull --quiet`, { stdio: "pipe" });
    } else {
      log.dim(`  [clawhub] Cloning skills monorepo for ${author}`);
      execSync(`git clone --quiet --depth 1 ${monoUrl} ${monoCache}`, { stdio: "pipe" });
    }
    const skillPath = path.join(monoCache, skill.name);
    if (fs.existsSync(skillPath)) return skillPath;
    log.warn(`  [clawhub] Skill ${skill.name} not found in ${author}/skills monorepo`);
  } catch {
    log.warn(`  [clawhub] Could not fetch ${skill.name} from ${author} — skipping`);
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Tier 2: Continuous Agentics private registry
// ---------------------------------------------------------------------------

/**
 * Private CA skills are npm packages published to GitHub Packages (or Verdaccio).
 * They are installed into a temp dir and the skill directory is extracted.
 *
 * Requires: CA_REGISTRY_TOKEN (or custom token_env) in environment.
 * Package name convention: @continuous-agentics/<skill-name>
 */
async function resolvePrivate(skill: SkillRef, registry: PrivateRegistry): Promise<string | undefined> {
  const token = process.env[registry.token_env];
  if (!token) {
    log.error(`  Skill ${skill.name}: source=private requires env var ${registry.token_env}`);
    return undefined;
  }

  ensureCache();
  const pkgName = `${registry.scope}/${skill.name}`;
  const version = skill.version ?? "latest";
  const dest = cacheDir("private", `${skill.name}@${version}`);

  if (fs.existsSync(dest)) {
    log.dim(`  [private] Using cached ${pkgName}@${version}`);
    return dest;
  }

  const tmpDir = path.join(CACHE_BASE, "private", `.tmp-${skill.name}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Write a scoped .npmrc so npm knows where to authenticate
  const npmrc = `${registry.scope}:registry=${registry.url}\n//npm.pkg.github.com/:_authToken=${token}\n`;
  const npmrcPath = path.join(tmpDir, ".npmrc");
  fs.writeFileSync(npmrcPath, npmrc, { mode: 0o600 });

  try {
    log.dim(`  [private] Installing ${pkgName}@${version} from ${registry.url}`);
    execSync(
      `npm install --prefix ${tmpDir} --userconfig ${npmrcPath} ${pkgName}@${version} --no-save --quiet`,
      { stdio: "pipe" }
    );

    // npm installs to node_modules/<scope>/<name>
    const installed = path.join(tmpDir, "node_modules", registry.scope, skill.name);
    if (!fs.existsSync(installed)) {
      log.error(`  [private] ${pkgName} installed but skill directory not found at ${installed}`);
      return undefined;
    }

    // Move to cache
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(installed, dest, { recursive: true });
    fs.rmSync(tmpDir, { recursive: true });

    return dest;
  } catch (err) {
    log.error(`  [private] Failed to install ${pkgName}: ${String(err)}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tier 3: Client skills repo
// ---------------------------------------------------------------------------

/**
 * Client skills come from the client's own skills_repo (local path or git remote).
 * This is the existing behavior — skills live in <skills_repo.local>/<name>
 * or in the cloned cache of skills_repo.url.
 */
function resolveClient(skill: SkillRef, fleet: Fleet, cloneCache: string): string | undefined {
  const candidates: string[] = [];

  if (fleet.skills_repo.local) {
    candidates.push(path.resolve(fleet.skills_repo.local, skill.name));
  }
  candidates.push(path.resolve("./skills", skill.name));
  if (fs.existsSync(cloneCache)) {
    candidates.push(path.join(cloneCache, skill.name));
  }

  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) {
    if (fleet.skills_repo.url) {
      log.warn(`  [client] Skill ${skill.name} not found locally — remote install from ${fleet.skills_repo.url} (clone first with fleetmind watch)`);
    } else {
      log.warn(`  [client] Skill ${skill.name} not found — skipping`);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Public resolver
// ---------------------------------------------------------------------------

const CLIENT_CACHE = path.join(process.env.HOME ?? "/tmp", ".fleetmind", "skills-cache");

export async function resolveSkill(skill: SkillRef, fleet: Fleet): Promise<string | undefined> {
  const source = skill.source ?? "client";

  switch (source) {
    case "clawhub":
      return resolveClawHub(skill);

    case "private":
      return resolvePrivate(skill, fleet.private_registry);

    case "client":
    default:
      return resolveClient(skill, fleet, CLIENT_CACHE);
  }
}

export async function installSkill(
  skill: SkillRef,
  destDir: string,
  fleet: Fleet,
  dryRun: boolean
): Promise<void> {
  const label = `[${skill.source ?? "client"}] ${skill.name}${skill.version ? `@${skill.version}` : ""}`;

  if (dryRun) {
    log.dim(`  (dry-run) Would install ${label}`);
    return;
  }

  const src = await resolveSkill(skill, fleet);
  if (!src) return;

  const dest = path.join(destDir, skill.name);
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  log.ok(`  Installed ${label}`);
}
