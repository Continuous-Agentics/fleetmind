/**
 * `fleetmind up` — bring a fleet up on the local machine (no cloud).
 *
 * The local counterpart to the AWS deploy flow. Where AWS runs one gateway per
 * EC2 host, a local box runs ONE OpenClaw gateway hosting every agent assigned
 * to its `local` target (OpenClaw's native multi-agent model). FleetMind owns
 * config + secrets + workspaces; OpenClaw owns the daemon:
 *
 *   1. provision each agent's workspace (skills, persona) → <workspace_base>/<id>
 *   2. render the host's openclaw.json → ~/.openclaw/openclaw.json
 *   3. resolve secrets → ~/.openclaw/.env (chmod 600; OpenClaw substitutes them)
 *   4. check Node + openclaw, then delegate the daemon to `openclaw onboard
 *      --install-daemon` (OpenClaw installs the launchd/systemd user service).
 *
 * Secrets stay as ${VAR} references in openclaw.json (resolved by OpenClaw from
 * ~/.openclaw/.env), never baked into the config — hence loadFleet({ expandEnv:
 * false }).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Command } from "commander";
import { loadFleet } from "../../config/loader.js";
import type { Fleet, ResolvedTarget } from "../../core/model.js";
import { injectSecrets } from "../../utils/secrets.js";
import { renderHostOpenClawJson, agentsForTarget } from "../../runtime/renderer.js";
import { provisionFleet } from "../../runtime/provisioner.js";
import { materializeHostEnv } from "./populate.js";
import { log } from "../../utils/log.js";

/** Expand a leading `~/` to the user's home directory. */
function expandTilde(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * The single `local` target a `fleetmind up` runs against. Errors loudly when
 * there are none (this isn't a local fleet) or several (ambiguous which box we
 * are — multi-box local is an ssh-target concern handled per-host elsewhere).
 */
export function resolveLocalTarget(fleet: Fleet): ResolvedTarget {
  const locals = [...fleet.targetMap.values()].filter((t) => t.provider === "local");
  if (locals.length === 0) {
    throw new Error(
      "`fleetmind up` needs a target with `provider: local`. " +
        "Add one to `targets:` and point an agent at it, or use `fleetmind push fleet` for remote hosts."
    );
  }
  if (locals.length > 1) {
    throw new Error(
      `Found ${locals.length} local targets (${locals.map((t) => t.id).join(", ")}). ` +
        "`fleetmind up` brings up a single local host; give the box you're on one local target."
    );
  }
  return locals[0]!;
}

/** Place each host agent's provisioned workspace at <workspace_base>/<id>.
 *  Provisions to a temp staging dir (provisionFleet's fixed layout) then copies
 *  only this host's agents into place. */
async function stageWorkspaces(
  fleet: Fleet,
  agentIds: string[],
  workspaceBase: string,
  dryRun: boolean
): Promise<void> {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "fleetmind-up-"));
  try {
    await provisionFleet(fleet, dryRun, staging);
    if (dryRun) return;
    for (const id of agentIds) {
      const src = path.join(staging, "rendered", "workspaces", id);
      const dest = path.join(workspaceBase, id);
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
      log.ok(`workspace → ${dest}`);
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Write the host's openclaw.json (+ openclaw.base.json, which OpenClaw requires
 *  as a baseline), backing up any existing config first. */
function writeOpenClawConfig(fleet: Fleet, targetId: string, openclawHome: string): void {
  fs.mkdirSync(openclawHome, { recursive: true });
  const configPath = path.join(openclawHome, "openclaw.json");
  if (fs.existsSync(configPath)) {
    const backup = `${configPath}.bak-${Date.now()}`;
    fs.copyFileSync(configPath, backup);
    log.dim(`backed up existing config → ${backup}`);
  }
  const json = JSON.stringify(renderHostOpenClawJson(fleet, targetId), null, 2);
  fs.writeFileSync(configPath, json);
  fs.writeFileSync(path.join(openclawHome, "openclaw.base.json"), json);
  log.ok(`config → ${configPath}`);
}

/** Write ~/.openclaw/.env (0600) from resolved VAR=value pairs. */
function writeEnvFile(vars: Record<string, string>, openclawHome: string): string {
  const envPath = path.join(openclawHome, ".env");
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.writeFileSync(envPath, body ? `${body}\n` : "", { mode: 0o600 });
  return envPath;
}

/** True if `bin` resolves on PATH. */
function onPath(bin: string): boolean {
  try {
    execFileSync("command", ["-v", bin], { stdio: "ignore", shell: "/bin/sh" });
    return true;
  } catch {
    return false;
  }
}

export interface UpOptions {
  fleet?: string;
  dryRun: boolean;
  /** When false, stage config/env/workspaces but don't touch the OpenClaw daemon. */
  daemon: boolean;
  /** Override the OpenClaw home (defaults to ~/.openclaw). Mainly for tests. */
  openclawHome?: string;
}

export async function runUp(opts: UpOptions): Promise<void> {
  injectSecrets(); // load ~/.fleetmind/secrets.json into process.env for resolution
  const fleetFile = opts.fleet ?? "fleet.yaml";
  // expandEnv:false so secret ${VAR} placeholders survive into openclaw.json.
  const fleet = loadFleet(fleetFile, { expandEnv: false });

  const target = resolveLocalTarget(fleet);
  const hostAgents = agentsForTarget(fleet, target.id);
  if (hostAgents.length === 0) {
    throw new Error(`No agents are assigned to local target "${target.id}".`);
  }
  const workspaceBase = expandTilde(target.workspace_base);
  const openclawHome = opts.openclawHome ?? path.join(os.homedir(), ".openclaw");

  log.info(
    `Bringing up ${hostAgents.length} agent(s) on local host "${target.id}": ` +
      hostAgents.map((a) => a.id).join(", ")
  );
  if (opts.dryRun) log.warn("Dry run — no files written, daemon untouched.\n");

  // 1. Workspaces → <workspace_base>/<id>
  await stageWorkspaces(fleet, hostAgents.map((a) => a.id), workspaceBase, opts.dryRun);

  // 2 + 3. Config + secrets (skipped on dry-run)
  const { vars, missing } = materializeHostEnv(fleet, target.id, process.env as Record<string, string>);
  if (missing.length > 0) {
    log.warn(`Unresolved secrets (set via \`fleetmind secrets set\` or env): ${missing.join(", ")}`);
  }
  if (!opts.dryRun) {
    writeOpenClawConfig(fleet, target.id, openclawHome);
    const envPath = writeEnvFile(vars, openclawHome);
    log.ok(`secrets → ${envPath} (${Object.keys(vars).length} var${Object.keys(vars).length === 1 ? "" : "s"}, chmod 600)`);
  }

  // 4. Daemon — delegate to OpenClaw (it owns the launchd/systemd service).
  if (opts.dryRun) return;
  if (!opts.daemon) {
    log.info("Config staged. Start the gateway daemon with:");
    log.info("  openclaw onboard --install-daemon   # then: openclaw gateway status");
    return;
  }
  if (!onPath("openclaw")) {
    log.warn("`openclaw` not found on PATH. Install it, then re-run `fleetmind up`:");
    log.info("  npm install -g openclaw@latest   # requires Node 24 (or 22.19+)");
    if (!onPath("node")) log.info("  (Node is also missing — install Node first, e.g. `brew install node`)");
    return;
  }
  log.info("Delegating daemon install to OpenClaw (`openclaw onboard --install-daemon`)…");
  execFileSync("openclaw", ["onboard", "--install-daemon"], { stdio: "inherit" });
  log.success("Fleet is up. Check it with: openclaw gateway status");
}

export function registerUp(program: Command): void {
  program
    .command("up [fleet]")
    .description("Bring a fleet up locally: render config + secrets to ~/.openclaw and start the OpenClaw gateway daemon")
    .option("-f, --fleet <path>", "fleet.yaml path (overrides positional arg)")
    .option("--dry-run", "Show what would happen without writing files or touching the daemon", false)
    .option("--no-daemon", "Stage config/secrets/workspaces but don't install/start the gateway daemon")
    .addHelpText("after", `
Examples:
  # Bring the local fleet up and start the gateway daemon
  $ fleetmind up

  # Stage everything but leave the daemon to you
  $ fleetmind up --no-daemon

  # Preview without writing anything
  $ fleetmind up --dry-run

Requires a target with \`provider: local\` that your agents reference. Secrets
are resolved from \`fleetmind secrets set\` / the environment and written to
~/.openclaw/.env; OpenClaw substitutes them at runtime.
`)
    .action(async (fleetArg: string | undefined, opts: { fleet?: string; dryRun: boolean; daemon: boolean }) => {
      try {
        await runUp({
          fleet: opts.fleet ?? fleetArg,
          dryRun: opts.dryRun ?? false,
          daemon: opts.daemon !== false,
        });
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }
    });
}
