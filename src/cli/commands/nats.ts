/**
 * fleetmind nats — NATS inter-bot messaging subscriber
 *
 * Runs as a long-lived systemd service on each agent.
 * Subscribes to NATS for inter-bot delegation events and routes them to the local agent.
 *
 * Usage:
 *   fleetmind nats subscribe --mode pm                 # PM bot subscriber
 *   fleetmind nats subscribe --mode worker --worker-id forge  # Worker bot subscriber
 *
 * Configuration:
 *   Reads fleet.yaml from FLEET_YAML env var or cwd.
 *   Connects to nats://<fleet_name>.internal:4222
 *   Credentials passed via NATS_USERNAME / NATS_PASSWORD env vars (optional).
 */

import { Command } from "commander";
import { connect, JSONCodec, type NatsConnection } from "nats";
import { loadFleet } from "../../config/loader.js";
import { log } from "../../utils/log.js";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── Message type from NATS topic ──────────────────────────────────────────────

interface DelegationMessage {
  task_id: string;
  worker_id: string;
  delegated_by: string;
  definition_of_done: string;
  delegation_thread: string;
  delegation_envelope_ts: string;
  [key: string]: unknown;
}

/**
 * Resolve the agent ID from the runtime environment.
 * Priority: /etc/fleetmind/agent.env AGENT_ID → AGENT_ID env var → fallback
 */
function resolveAgentId(fallback: string = "unknown"): string {
  try {
    const env = readFileSync("/etc/fleetmind/agent.env", "utf8");
    const match = /^AGENT_ID=(.+)$/m.exec(env);
    if (match?.[1]) return match[1].trim();
  } catch {
    // not on a bot host or env file missing
  }
  return process.env["AGENT_ID"] ?? fallback;
}

/**
 * Resolve the gateway token for webhook authentication.
 * Priority: /run/openclaw-<agent>.env GATEWAY_TOKEN → GATEWAY_TOKEN env var
 */
function resolveGatewayToken(agentId: string): string {
  try {
    const env = readFileSync(`/run/openclaw-${agentId}.env`, "utf8");
    const match = /^GATEWAY_TOKEN=(.+)$/m.exec(env);
    if (match?.[1]) return match[1].trim();
  } catch {
    // env file not yet present
  }
  return process.env["GATEWAY_TOKEN"] ?? "";
}

// ── Route message to the local OpenClaw gateway ────────────────────────────────

async function routeToGateway(
  agentId: string,
  message: DelegationMessage,
  gatewayToken: string
): Promise<void> {
  const gatewayPort = process.env["GATEWAY_PORT"] ?? "18789";
  const gatewayUrl = `http://localhost:${gatewayPort}/nats-delegation`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (gatewayToken) {
    headers["Authorization"] = `Bearer ${gatewayToken}`;
  }

  try {
    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      log.warn(`Gateway routing failed: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    log.error(`Failed to route message to gateway: ${String(err)}`);
  }
}

// ── PM-mode subscriber: listen for worker completion events ───────────────────

async function subscribePM(nc: NatsConnection, fleetName: string): Promise<void> {
  const jc = JSONCodec<DelegationMessage>();

  // Topic: "delegation.workers.*.completed"
  // Workers publish task completion here
  const sub = nc.subscribe("delegation.workers.*.completed");

  log.info(`PM subscriber listening on delegation.workers.*.completed`);

  for await (const msg of sub) {
    try {
      const message = jc.decode(msg.data);
      log.info(`Received worker completion: task=${message.task_id} worker=${message.worker_id}`);
      // In a real implementation, route to PM bot's event handler
      // For now, just log
    } catch (err) {
      log.error(`Failed to decode message on ${msg.subject}: ${String(err)}`);
    }
  }
}

// ── Worker-mode subscriber: listen for new task delegations ─────────────────────

async function subscribeWorker(
  nc: NatsConnection,
  workerId: string,
  agentId: string,
  gatewayToken: string
): Promise<void> {
  const jc = JSONCodec<DelegationMessage>();

  // Topic: "delegation.workers.<worker_id>.assigned"
  // PM publishes new tasks here
  const subject = `delegation.workers.${workerId}.assigned`;
  const sub = nc.subscribe(subject);

  log.info(`Worker subscriber listening on ${subject}`);

  for await (const msg of sub) {
    try {
      const message = jc.decode(msg.data);
      log.info(`Received task delegation: task=${message.task_id} worker=${message.worker_id}`);

      // Route to the local agent's gateway
      await routeToGateway(agentId, message, gatewayToken);
    } catch (err) {
      log.error(`Failed to process message on ${msg.subject}: ${String(err)}`);
    }
  }
}

// ── Main subscribe command ─────────────────────────────────────────────────────

export function registerNats(program: Command): void {
  program
    .command("nats")
    .description("NATS inter-bot messaging (systemd service)")
    .addCommand(
      new Command("subscribe")
        .requiredOption("--mode <mode>", "Subscription mode: 'pm' or 'worker'")
        .option("--worker-id <id>", "Worker agent ID (required when mode=worker)")
        .option("--json", "Output JSON logs (default: human-readable)")
        .addHelpText(
          "after",
          `
Examples:
  # PM bot subscriber (listens for worker completion events)
  $ fleetmind nats subscribe --mode pm

  # Worker bot subscriber (listens for new task delegations)
  $ fleetmind nats subscribe --mode worker --worker-id forge
`
        )
        .action(async (opts) => {
          try {
            const mode = opts.mode?.toLowerCase();
            if (!["pm", "worker"].includes(mode)) {
              throw new Error(`Invalid mode: ${mode}. Must be 'pm' or 'worker'.`);
            }

            if (mode === "worker" && !opts.workerId) {
              throw new Error("--worker-id is required when mode=worker");
            }

            // Load fleet.yaml to get fleet name and NATS config
            const fleetFile = process.env["FLEET_YAML"] ?? "fleet.yaml";
            const fleet = loadFleet(fleetFile);

            if (!fleet.delegation?.enabled) {
              throw new Error("Delegation is not enabled in fleet.yaml");
            }

            if (!fleet.delegation.nats) {
              throw new Error("NATS config is required in delegation block");
            }

            const fleetName = fleet.fleet.name;
            const natsMode = fleet.delegation.nats.mode ?? "standard";

            // For 'standard' mode, NATS is at Cloud Map DNS
            let natsUrl = `nats://${fleetName}.internal:4222`;

            // Allow override via env var (useful for testing)
            if (process.env["NATS_URL"]) {
              natsUrl = process.env["NATS_URL"];
            }

            log.info(`Connecting to NATS at ${natsUrl} (mode=${natsMode})`);

            // Connect to NATS
            // Note: nats client handles reconnection automatically
            const nc = await connect({
              servers: natsUrl,
              user: process.env["NATS_USERNAME"],
              pass: process.env["NATS_PASSWORD"],
              name: `fleetmind-${mode}-${opts.workerId || "pm"}`,
            });

            log.info(`Connected to NATS server`);

            // Set up graceful shutdown
            const handleShutdown = async () => {
              log.info("Shutting down NATS subscriber...");
              await nc.close();
              process.exit(0);
            };

            process.on("SIGTERM", handleShutdown);
            process.on("SIGINT", handleShutdown);

            // Start appropriate subscriber
            if (mode === "pm") {
              await subscribePM(nc, fleetName);
            } else {
              const agentId = resolveAgentId(opts.workerId);
              const gatewayToken = resolveGatewayToken(agentId);
              await subscribeWorker(nc, opts.workerId, agentId, gatewayToken);
            }
          } catch (err) {
            log.error(String(err));
            process.exit(1);
          }
        })
    );
}
