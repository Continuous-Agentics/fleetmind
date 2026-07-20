/**
 * `fleetmind self-upgrade` — in-place CLI version update without a bash incantation.
 *
 * Replaces the manual npm install → verify → optional restart dance with a
 * single command. Must run as root.
 *
 * Usage:
 *   sudo fleetmind self-upgrade --version <semver> [--apply] [--restart] [--region <r>]
 *   sudo fleetmind self-upgrade --latest [--apply] [--restart] [--region <r>]
 *
 * Exit codes:
 *   0 — success (or dry-run)
 *   1 — validation error, root check failure, or SSM fetch failure
 *   2 — npm install failure
 *   3 — post-install version mismatch
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { Command } from "commander";
import { log } from "../../utils/log.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const AGENT_ENV_PATH = "/etc/fleetmind/agent.env";
const PACKAGE_NAME = "@ggettert/fleetmind";

// ── Dependency-injection interfaces ──────────────────────────────────────────

/** Result from running npm install -g. */
export interface NpmInstallResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Injectable dependencies — all optional for production use. */
export interface SelfUpgradeDeps {
  /** Run `npm install -g <pkg>`. Returns exit code + output. */
  runNpmInstall?: (pkg: string) => NpmInstallResult;
  /** Read current installed version via `fleetmind --version`. */
  readCurrentVersion?: () => string;
  /** Restart the gateway systemd unit. */
  restartFn?: (unit: string) => void;
  /** Override euid check (for tests). Default: process.getuid(). */
  getEuid?: () => number;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface SelfUpgradeOptions {
  to?: string;
  latest: boolean;
  apply: boolean;
  restart: boolean;
  region: string;
}

// ── Default production implementations ───────────────────────────────────────

function defaultReadCurrentVersion(): string {
  try {
    const out = execFileSync("fleetmind", ["--version"], { encoding: "utf8" });
    return out.trim();
  } catch {
    return "unknown";
  }
}

/**
 * Resolve the npm global prefix used by the currently installed fleetmind binary.
 * This ensures the upgrade installs to the same location as the running binary
 * rather than the current user's home-dir npm prefix (which would diverge
 * when self-upgrade is invoked as ec2-user but the system install lives under
 * the root npm prefix, e.g. /usr).
 */
function resolveNpmPrefix(): string {
  try {
    // Walk up from the running module to find the npm prefix:
    // <prefix>/lib/node_modules/@ggettert/fleetmind/dist/...
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/cli/commands -> dist/cli -> dist -> package root -> node_modules -> lib -> prefix
    const pkgRoot = path.resolve(here, "..", "..", "..");
    const nodeModules = path.dirname(pkgRoot);   // @continuous-agentics
    const scopeParent  = path.dirname(nodeModules); // node_modules
    const lib          = path.dirname(scopeParent);  // lib
    const prefix       = path.dirname(lib);          // /usr or /usr/local etc.
    return prefix;
  } catch {
    return "/usr"; // safe fallback for Amazon Linux 2023
  }
}

function defaultRunNpmInstall(pkg: string): NpmInstallResult {
  const prefix = resolveNpmPrefix();
  // If the prefix is root-owned (e.g. /usr), the current user may not have
  // write access. Use sudo so the binary lands in the same location as the
  // original system install.
  const needsSudo = (() => { try { fs.accessSync(prefix, fs.constants.W_OK); return false; } catch { return true; } })();

  const npmArgs = ["install", "-g", "--prefix", prefix, pkg];
  const cmd = needsSudo ? "sudo" : "npm";
  const args = needsSudo ? ["npm", ...npmArgs] : npmArgs;

  try {
    const stdout = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: e.status ?? 2,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(err),
    };
  }
}

function defaultRestartFn(unit: string): void {
  execFileSync("systemctl", ["restart", unit], { stdio: "inherit" });
}

// ── Helper: parse AGENT_ID from /etc/fleetmind/agent.env ─────────────────────

function readAgentIdFromEnv(): string {
  if (!fs.existsSync(AGENT_ENV_PATH)) {
    throw new Error(
      `${AGENT_ENV_PATH} not found. Cannot determine AGENT_ID for --restart.\n` +
        "Set AGENT_ID in the environment or create the file."
    );
  }
  const text = fs.readFileSync(AGENT_ENV_PATH, "utf-8");
  const m = text.match(/^AGENT_ID=(.+)$/m);
  if (!m?.[1]) {
    throw new Error(`AGENT_ID not found in ${AGENT_ENV_PATH}`);
  }
  return m[1].trim();
}

// ── Core logic ────────────────────────────────────────────────────────────────

export async function runSelfUpgrade(
  opts: SelfUpgradeOptions,
  deps: SelfUpgradeDeps = {}
): Promise<void> {
  const getEuid = deps.getEuid ?? (() => process.getuid!());
  const readCurrentVersion = deps.readCurrentVersion ?? defaultReadCurrentVersion;
  const runNpmInstall = deps.runNpmInstall ?? defaultRunNpmInstall;
  const restartFn = deps.restartFn ?? defaultRestartFn;

  // ── Step 1: Root check ───────────────────────────────────────────────────
  if (getEuid() !== 0) {
    log.error(
      "fleetmind self-upgrade must run as root. Re-run with:\n\n" +
        `  sudo fleetmind self-upgrade ${process.argv.slice(3).join(" ")}`
    );
    process.exit(1);
  }

  // ── Step 2: Validate flags ────────────────────────────────────────────────
  const hasVersion = opts.to !== undefined && opts.to !== "";
  const hasLatest = opts.latest;

  if (!hasVersion && !hasLatest) {
    log.error("Specify exactly one of --to <semver> or --latest.");
    process.exit(1);
  }

  if (hasVersion && hasLatest) {
    log.error("--to and --latest are mutually exclusive. Specify only one.");
    process.exit(1);
  }

  // ── Step 3: Determine target version string ────────────────────────────
  // For --latest, npm resolves "latest" tag at install time.
  const targetTag = hasVersion ? opts.to! : "latest";
  const targetPkg = `${PACKAGE_NAME}@${targetTag}`;

  // ── Step 4: Read current version ─────────────────────────────────────────
  const currentVersion = readCurrentVersion();
  console.log(`fleetmind self-upgrade`);
  console.log(`  current : ${currentVersion}`);
  console.log(`  target  : ${targetTag}`);

  // ── Step 5: Dry-run / no-apply path ──────────────────────────────────────
  if (!opts.apply) {
    console.log(`\n[dry-run] Would run: npm install -g ${targetPkg}`);
    if (opts.restart) {
      console.log(`[dry-run] Would restart: openclaw-<AGENT_ID>`);
    }
    console.log(`\nRe-run with --apply to perform the upgrade.`);
    return;
  }

  // ── Step 6: Set up signal handlers ───────────────────────────────────────
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (sig: NodeJS.Signals) => {
    log.error(`Aborted by signal ${sig}.`);
    process.exit(1);
  };

  for (const sig of signals) {
    process.on(sig, () => onSignal(sig));
  }

  process.on("uncaughtException", (err) => {
    log.error(`Uncaught error: ${String(err)}`);
    process.exit(1);
  });

  try {
    // ── Step 7: npm install -g ─────────────────────────────────────────────
    log.step(`Installing ${targetPkg}...`);
    const result = runNpmInstall(targetPkg);

    if (result.exitCode !== 0) {
      if (result.stderr) console.error(result.stderr);
      log.error(`npm install -g ${targetPkg} failed (exit ${result.exitCode})`);
      process.exit(2);
    }

    // ── Step 8: Verify post-install version ───────────────────────────────
    log.step("Verifying installed version...");
    const installedVersion = readCurrentVersion();

    if (hasVersion && installedVersion !== opts.to) {
      log.error(
        `Version mismatch after install.\n` +
          `  requested: ${opts.to}\n` +
          `  installed: ${installedVersion}\n` +
          "npm may have served a cached or different version. Try clearing the npm cache."
      );
      process.exit(3);
    }

    // ── Step 9: Restart if requested ──────────────────────────────────────
    if (opts.restart) {
      log.step("Reading AGENT_ID for restart...");
      const agentId = readAgentIdFromEnv();
      const unit = `openclaw-${agentId}`;
      log.step(`Restarting ${unit}...`);
      log.warn(
        `⚠  Restarting ${unit} will interrupt any in-flight agent work.`
      );
      restartFn(unit);
      log.ok(`${unit} restarted`);
    }

    // ── Step 10: Summary ──────────────────────────────────────────────────
    console.log(`\n✓ Upgraded fleetmind ${currentVersion} → ${installedVersion}`);
  } catch (err: unknown) {
    throw err;
  }
}

// ── Commander registration ────────────────────────────────────────────────────

export function registerSelfUpgrade(program: Command): void {
  program
    .command("self-upgrade")
    .description(
      "Upgrade the fleetmind CLI in-place from public npm (must run as root)"
    )
    .option("--to <semver>", "Install a specific version (mutually exclusive with --latest)")
    .option("--latest", "Install the latest version from public npm", false)
    .option(
      "--apply",
      "Perform the install. Without this flag, prints what would happen (dry-run)",
      false
    )
    .option("--restart", "After successful install, restart openclaw-<AGENT_ID>", false)
    .option("--region <region>", "Deprecated; accepted for backward compatibility", "us-west-2")
    .addHelpText('after', `
Examples:
  # Dry-run: preview what would happen (no changes made)
  $ sudo fleetmind self-upgrade --to 0.5.0

  # Install a specific version
  $ sudo fleetmind self-upgrade --to 0.5.0 --apply

  # Install the latest version
  $ sudo fleetmind self-upgrade --latest --apply

  # Install latest and restart the gateway in one shot
  $ sudo fleetmind self-upgrade --latest --apply --restart

Note: this command must run as root (sudo). FleetMind installs from public npm;
no GitHub Packages token or temporary .npmrc is required.
`)
    .action(async (opts: {
      to?: string;
      latest: boolean;
      apply: boolean;
      restart: boolean;
      region: string;
    }) => {
      try {
        await runSelfUpgrade({
          to: opts.to,
          latest: opts.latest,
          apply: opts.apply,
          restart: opts.restart,
          region: opts.region,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(msg);
        process.exit(1);
      }
    });
}
