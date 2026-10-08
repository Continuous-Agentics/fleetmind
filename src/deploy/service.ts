/**
 * ServiceManager — host-side (re)start of an agent's gateway and NATS
 * subscriber, abstracted over the host's service supervisor.
 *
 * Consumed by `pull-self` on the host after it applies a new bundle. Each agent
 * runs as a supervised service (`openclaw-<agent>`) plus, on worker hosts, a
 * NATS subscriber (`fleetmind-nats-<agent>`); the supervisor differs by OS —
 * systemd on Linux/EC2, launchd on macOS. The fleetmind service *identity* is
 * the same across supervisors (keyed by agent id); each adapter maps it to its
 * concrete unit/label and owns the mechanics.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveOpenClawBinary } from "../runtime/openclaw-config.js";
import type { TargetProvider } from "../config/schema.js";

export type ServiceManagerKind = "systemd" | "launchd" | "none";

export interface ServiceManager {
  /** Restart the agent's gateway service. Throws if the restart fails. */
  restartGateway(agentId: string): void;
  /** Restart the agent's NATS subscriber if present; tolerate its absence
   *  (PM hosts have no NATS subscriber unit). */
  restartNatsSubscriber(agentId: string): void;
}

/** systemd (Linux / EC2). Runs via `sudo systemctl` — retained for existing
 * non-AWS and system-service hosts. */
export class SystemdServiceManager implements ServiceManager {
  restartGateway(agentId: string): void {
    execFileSync("sudo", ["systemctl", "restart", `openclaw-${agentId}`], { stdio: "inherit" });
  }

  restartNatsSubscriber(agentId: string): void {
    // reset-failed first: on existing hosts the unit can be in a failed state
    // with an exhausted restart counter, which systemd refuses to retry without
    // a reset. The path unit alone isn't enough to recover that.
    try {
      execFileSync("sudo", ["systemctl", "reset-failed", `fleetmind-nats-${agentId}`], { stdio: "inherit" });
      execFileSync("sudo", ["systemctl", "restart", `fleetmind-nats-${agentId}`], { stdio: "inherit" });
    } catch {
      // Service may not exist on all hosts (e.g. PM bots without a NATS unit).
      process.stderr.write(`[pull-self] fleetmind-nats-${agentId} not found or failed to restart — skipping\n`);
    }
  }
}

function validSelfManagedBase(base: string, unit: string, prefix: string): boolean {
  if (!fs.existsSync(base)) return false;
  const installed = fs.readFileSync(base, "utf8");
  return installed.includes(`OPENCLAW_SYSTEMD_UNIT=${unit}`) &&
    installed.split("\n").some((line) => line.startsWith("ExecStart=") && line.includes(prefix + "/"));
}

function activationReceiptPath(home: string, agentId: string): string {
  return path.join(home, `.config/fleetmind/openclaw-native-service-${agentId}.json`);
}

function writeActivationReceipt(receipt: string, unit: string): void {
  const temp = `${receipt}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify({ schema: 1, unit, owner: "openclaw-native" }) + "\n", { mode: 0o600 });
  fs.renameSync(temp, receipt);
}

function hasActivationReceipt(receipt: string, unit: string): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(receipt, "utf8"));
    return value.schema === 1 && value.unit === unit && value.owner === "openclaw-native";
  } catch {
    return false;
  }
}

function isHealthyNativeInstallation(unit: string, base: string, prefix: string): boolean {
  try {
    const show = (property: string) => execFileSync("systemctl", ["--user", "show", unit, `--property=${property}`, "--value"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000,
    }).trim();
    const fragment = show("FragmentPath");
    return show("LoadState") === "loaded" &&
      show("UnitFileState").startsWith("enabled") &&
      show("NeedDaemonReload") === "no" &&
      show("ActiveState") === "active" &&
      path.resolve(fragment) === path.resolve(base) &&
      show("ExecStart").includes(prefix + "/");
  } catch {
    return false;
  }
}

/** Fresh self-managed hosts intentionally have no placeholder base service.
 * The native installer writes it only after the first validated config push.
 * A durable successful-activation receipt (or a fully healthy manager view for
 * migrated hosts) distinguishes completion from a base published just before
 * daemon-reload/enable/restart failed. Later native updates are never replaced.
 */
export function ensureSelfManagedGatewayInstalled(agentId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(agentId)) throw new Error("Invalid service identity");
  const home = process.env.HOME || os.homedir();
  const selector = path.join(home, ".config/fleetmind/openclaw-runtime.json");
  if (!fs.existsSync(selector)) return; // existing root-managed hosts
  const runtime = JSON.parse(fs.readFileSync(selector, "utf8"));
  if (runtime.mode !== "self-managed") return;
  const unit = `openclaw-${agentId}.service`;
  const base = path.join(home, ".config/systemd/user", unit);
  const prefix = path.join(home, ".local/share/fleetmind/openclaw-runtime");
  const receipt = activationReceiptPath(home, agentId);
  if (validSelfManagedBase(base, unit, prefix) &&
      (hasActivationReceipt(receipt, unit) || isHealthyNativeInstallation(unit, base, prefix))) {
    if (!hasActivationReceipt(receipt, unit)) writeActivationReceipt(receipt, unit);
    return;
  }
  if (process.getuid?.() === 0) throw new Error("Self-managed service installation must run as the runtime user");
  if (!fs.existsSync(path.join(home, ".openclaw/openclaw.json")) ||
      !fs.existsSync(`${base}.d/50-fleetmind.conf`)) throw new Error("Self-managed service requires published config and FleetMind policy drop-in");
  const binary = resolveOpenClawBinary();
  if (!binary.startsWith(prefix + path.sep)) throw new Error("Self-managed launcher must be inside the dedicated prefix");
  execFileSync(binary, ["gateway", "install", "--force"], {
    env: { ...process.env, OPENCLAW_SYSTEMD_UNIT: unit, NPM_CONFIG_PREFIX: prefix },
    stdio: "inherit", timeout: 120_000,
  });
  if (!validSelfManagedBase(base, unit, prefix)) {
    throw new Error("Native installer did not persist the custom identity and dedicated launcher");
  }
  writeActivationReceipt(receipt, unit);
}

/** systemd user services. The caller must already be the runtime user and set
 * XDG_RUNTIME_DIR plus DBUS_SESSION_BUS_ADDRESS; AWS SSM command builders do
 * this before invoking `fleetmind pull-self --user-systemd`. */
export class UserSystemdServiceManager implements ServiceManager {
  restartGateway(agentId: string): void {
    ensureSelfManagedGatewayInstalled(agentId);
    execFileSync("systemctl", ["--user", "restart", `openclaw-${agentId}`], { stdio: "inherit" });
  }

  restartNatsSubscriber(agentId: string): void {
    try {
      execFileSync("systemctl", ["--user", "reset-failed", `fleetmind-nats-${agentId}`], { stdio: "inherit" });
      execFileSync("systemctl", ["--user", "restart", `fleetmind-nats-${agentId}`], { stdio: "inherit" });
    } catch {
      process.stderr.write(`[pull-self] fleetmind-nats-${agentId} not found or failed to restart — skipping\n`);
    }
  }
}

/** launchd (macOS — Mac mini / MacBook). Runs as a *user* LaunchAgent (no
 *  sudo), restarted via `launchctl kickstart -k gui/<uid>/<label>`. The plist
 *  is installed under ~/Library/LaunchAgents by the local-deploy install step,
 *  which must use these same labels. */
export class LaunchdServiceManager implements ServiceManager {
  static gatewayLabel(agentId: string): string {
    return `io.fleetmind.openclaw.${agentId}`;
  }
  static natsLabel(agentId: string): string {
    return `io.fleetmind.nats.${agentId}`;
  }

  private kickstart(label: string): void {
    const uid = process.getuid?.() ?? 0;
    // -k: kill the running instance first, then (re)start it.
    execFileSync("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`], { stdio: "inherit" });
  }

  restartGateway(agentId: string): void {
    this.kickstart(LaunchdServiceManager.gatewayLabel(agentId));
  }

  restartNatsSubscriber(agentId: string): void {
    const label = LaunchdServiceManager.natsLabel(agentId);
    try {
      this.kickstart(label);
    } catch {
      process.stderr.write(`[pull-self] ${label} not loaded or failed to restart — skipping\n`);
    }
  }
}

/** No supervisor — used by `local`/dev targets that don't run the gateway as a
 *  managed service. Restarts are no-ops. */
export class NoneServiceManager implements ServiceManager {
  restartGateway(_agentId: string): void {
    /* no managed service */
  }
  restartNatsSubscriber(_agentId: string): void {
    /* no managed service */
  }
}

/** Select the ServiceManager for a service-manager kind. */
export function serviceManagerFor(kind: ServiceManagerKind, userSystemd = false): ServiceManager {
  switch (kind) {
    case "systemd":
      return userSystemd ? new UserSystemdServiceManager() : new SystemdServiceManager();
    case "launchd":
      return new LaunchdServiceManager();
    case "none":
      return new NoneServiceManager();
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown service manager kind: ${String(_exhaustive)}`);
    }
  }
}

/** Map a target provider to its default service-manager kind. The host can
 *  still override via the target's explicit `service_manager`. */
export function defaultServiceManagerKind(provider: TargetProvider): ServiceManagerKind {
  switch (provider) {
    case "aws-ssm":
      return "systemd";
    case "ssh":
      return "systemd"; // most ssh targets (VMware/bare-metal Linux) use systemd
    case "local":
      return "none";
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown target provider: ${String(_exhaustive)}`);
    }
  }
}
