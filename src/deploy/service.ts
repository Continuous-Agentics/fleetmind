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

/** systemd user services. The caller must already be the runtime user and set
 * XDG_RUNTIME_DIR plus DBUS_SESSION_BUS_ADDRESS; AWS SSM command builders do
 * this before invoking `fleetmind pull-self --user-systemd`. */
export class UserSystemdServiceManager implements ServiceManager {
  restartGateway(agentId: string): void {
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
