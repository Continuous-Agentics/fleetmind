/**
 * FleetMind skill resolver — four-tier skill source resolution.
 *
 * Tier 1: clawhub   — public skills on ClaWHub, installed via the `clawhub` CLI
 * Tier 2: private   — Continuous Agentics proprietary library (GitHub Packages / npm private)
 * Tier 3: client    — skills in the client's own skills_repo (default)
 * Tier 4: fleetmind — first-party skills bundled with the fleetmind package
 *                     (openclaw/skills/<name>/), resolved via the package root.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import type { Fleet, SkillRef, PrivateRegistry } from "../config/schema.js";
import { log } from "../utils/log.js";

const CLIENT_CACHE = path.join(process.env.HOME ?? "/tmp", ".fleetmind", "skills-cache");

// ---------------------------------------------------------------------------
// Package-root detection
// ---------------------------------------------------------------------------

/**
 * Compute the fleetmind package root once and cache it.
 *
 * Works in both execution contexts:
 *   - Dev / tsx:  src/runtime/resolver.ts  → go up 2 dirs → package root
 *   - Built CLI:  dist/runtime/resolver.js → go up 2 dirs → package root
 *
 * The bundled first-party skills live at <packageRoot>/openclaw/skills/<name>/.
 */
function resolveFleetmindPackageRoot(): string {
  // import.meta.url is the file:// URL of *this* module (resolver.ts / resolver.js).
  // Going up two directories from src/runtime/ or dist/runtime/ always yields the
  // package root regardless of CWD or where the operator's fleet.yaml lives.
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), "..", "..");
}

let _packageRoot: string | undefined;

/** Cached package-root path. */
export function fleetmindPackageRoot(): string {
  if (!_packageRoot) _packageRoot = resolveFleetmindPackageRoot();
  return _packageRoot;
}

// ---------------------------------------------------------------------------
// Tier 1: ClaWHub — via the `clawhub` CLI
// ---------------------------------------------------------------------------

/**
 * ClaWHub skills are installed using the official `clawhub` CLI.
 * `clawhub install <slug> --workdir <dest-parent> --dir skills [--version x]`
 * installs into <dest-parent>/skills/<slug>/
 *
 * The `author` field is ignored for resolution (ClaWHub slugs are globally unique)
 * but can be used for display/documentation purposes.
 */
async function resolveClawHub(skill: SkillRef, destDir: string, dryRun: boolean): Promise<boolean> {
  // Check clawhub CLI is available
  try {
    execSync("clawhub --version", { stdio: "pipe" });
  } catch {
    log.error(`  [clawhub] 'clawhub' CLI not found. It should be installed as a fleetmind dependency — try reinstalling: npm install -g @continuous-agentics/fleetmind`);
    return false;
  }

  const slug = skill.name;
  const versionFlag = skill.version ? `--version ${skill.version}` : "";
  // clawhub installs into <workdir>/skills/<slug>
  // We want it directly in destDir/<slug>, so workdir = parent of destDir
  const workdir = path.dirname(destDir);

  if (dryRun) {
    log.dim(`  (dry-run) Would run: clawhub install ${slug} ${versionFlag} --workdir ${workdir} --force`);
    return true;
  }

  try {
    log.dim(`  [clawhub] Installing ${slug}${skill.version ? `@${skill.version}` : ""}`);
    execSync(
      `clawhub install ${slug} ${versionFlag} --workdir ${workdir} --no-input --force`,
      { stdio: "pipe" }
    );
    log.ok(`  [clawhub] ${slug} installed`);
    return true;
  } catch (err) {
    log.error(`  [clawhub] Failed to install ${slug}: ${String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tier 2: Continuous Agentics private registry (GitHub Packages)
// ---------------------------------------------------------------------------

/**
 * Private CA skills are npm packages published to GitHub Packages (or Verdaccio).
 * They are installed into a staging dir, skill dir is extracted, then moved to destDir.
 *
 * Requires: CA_REGISTRY_TOKEN (or custom token_env) in environment.
 * Package name convention: @continuous-agentics/<skill-name>
 */
async function resolvePrivate(
  skill: SkillRef,
  destDir: string,
  registry: PrivateRegistry,
  dryRun: boolean
): Promise<boolean> {
  const token = process.env[registry.token_env];
  if (!token) {
    log.error(`  [private] Skill ${skill.name}: requires env var ${registry.token_env}`);
    return false;
  }

  const pkgName = `${registry.scope}/${skill.name}`;
  const version = skill.version ?? "latest";

  if (dryRun) {
    log.dim(`  (dry-run) Would install ${pkgName}@${version} from ${registry.url}`);
    return true;
  }

  const tmpDir = path.join(
    process.env.HOME ?? "/tmp",
    ".fleetmind",
    "private-staging",
    skill.name
  );
  fs.mkdirSync(tmpDir, { recursive: true });

  // Scoped .npmrc for auth
  const npmrc = [
    `${registry.scope}:registry=${registry.url}`,
    `//npm.pkg.github.com/:_authToken=${token}`,
  ].join("\n") + "\n";
  const npmrcPath = path.join(tmpDir, ".npmrc");
  fs.writeFileSync(npmrcPath, npmrc, { mode: 0o600 });

  try {
    log.dim(`  [private] Installing ${pkgName}@${version} from ${registry.url}`);
    execSync(
      `npm install --prefix ${tmpDir} --userconfig ${npmrcPath} ${pkgName}@${version} --no-save --quiet`,
      { stdio: "pipe" }
    );

    const installed = path.join(tmpDir, "node_modules", registry.scope, skill.name);
    if (!fs.existsSync(installed)) {
      log.error(`  [private] ${pkgName} installed but skill dir not found at ${installed}`);
      fs.rmSync(tmpDir, { recursive: true });
      return false;
    }

    const dest = path.join(destDir, skill.name);
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
    fs.cpSync(installed, dest, { recursive: true });
    fs.rmSync(tmpDir, { recursive: true });

    log.ok(`  [private] ${pkgName}@${version} installed`);
    return true;
  } catch (err) {
    log.error(`  [private] Failed to install ${pkgName}: ${String(err)}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tier 4: FleetMind bundled first-party skills
// ---------------------------------------------------------------------------

/**
 * FleetMind first-party skills are shipped inside the fleetmind package itself
 * at `openclaw/skills/<skill.name>/`. They are NOT in the client's skills_repo
 * and do NOT require any CLI tooling beyond fleetmind itself.
 *
 * Use `source: fleetmind` in fleet.yaml for bundled skills like bot-delegation
 * and bot-reception. If the skill name is wrong, an explicit error is raised
 * (not a silent skip) because a typo in fleet.yaml is always a user error.
 */
async function resolveFleetmind(
  skill: SkillRef,
  destDir: string,
  dryRun: boolean
): Promise<boolean> {
  const pkgRoot = fleetmindPackageRoot();
  const src = path.join(pkgRoot, "openclaw", "skills", skill.name);

  if (!fs.existsSync(src)) {
    log.error(
      `  [fleetmind] Skill "${skill.name}" not found in bundled skills at ${src}. ` +
      `Check the skill name — bundled skills: bot-delegation, bot-reception.`
    );
    return false;
  }

  if (dryRun) {
    log.dim(`  (dry-run) Would copy bundled skill ${skill.name} from ${src}`);
    return true;
  }

  const dest = path.join(destDir, skill.name);
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  log.ok(`  [fleetmind] ${skill.name} installed from bundled skills`);
  return true;
}

// ---------------------------------------------------------------------------
// Tier 3: Client skills repo
// ---------------------------------------------------------------------------

/**
 * Client skills come from the client's own skills_repo (local path or cloned remote).
 * Resolution order: skills_repo.local → ./skills → cloned remote cache
 */
async function resolveClient(
  skill: SkillRef,
  destDir: string,
  fleet: Fleet,
  dryRun: boolean
): Promise<boolean> {
  const candidates: string[] = [];

  if (fleet.skills_repo.local) {
    candidates.push(path.resolve(fleet.skills_repo.local, skill.name));
  }
  candidates.push(path.resolve("./skills", skill.name));
  if (fs.existsSync(CLIENT_CACHE)) {
    candidates.push(path.join(CLIENT_CACHE, skill.name));
  }

  const src = candidates.find((c) => fs.existsSync(c));
  if (!src) {
    if (fleet.skills_repo.url) {
      log.warn(
        `  [client] Skill ${skill.name} not found locally — remote: ${fleet.skills_repo.url} (run 'fleetmind watch' to sync)`
      );
    } else {
      log.warn(`  [client] Skill ${skill.name} not found — skipping`);
    }
    return false;
  }

  if (dryRun) {
    log.dim(`  (dry-run) Would copy ${skill.name} from ${src}`);
    return true;
  }

  const dest = path.join(destDir, skill.name);
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  log.ok(`  [client] ${skill.name} installed from ${src}`);
  return true;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function installSkill(
  skill: SkillRef,
  destDir: string,
  fleet: Fleet,
  dryRun: boolean
): Promise<void> {
  const source = skill.source ?? "client";
  const label = `${skill.name}${skill.version ? `@${skill.version}` : ""} (${source}${skill.author ? `/${skill.author}` : ""})`;
  log.dim(`  → ${label}`);

  switch (source) {
    case "clawhub":
      await resolveClawHub(skill, destDir, dryRun);
      break;
    case "private":
      await resolvePrivate(skill, destDir, fleet.private_registry, dryRun);
      break;
    case "fleetmind":
      await resolveFleetmind(skill, destDir, dryRun);
      break;
    case "client":
    default:
      await resolveClient(skill, destDir, fleet, dryRun);
      break;
  }
}
