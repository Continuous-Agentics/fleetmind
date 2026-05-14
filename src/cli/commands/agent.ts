import { Command } from "commander";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import chalk from "chalk";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { loadFleet } from "../../config/loader.js";
import { log } from "../../utils/log.js";
import { lookupInstanceId } from "./pull-workspace.js";

export function registerAgent(program: Command): void {
  const agent = program
    .command("agent")
    .description("Manage individual agents")
    .addHelpText('after', `
Subcommands:
  list     List all agents in the fleet
  info     Show detailed info for a specific agent
  connect  SSM port-forward to a bot's gateway, with pre-flight health checks

Run \`fleetmind agent <subcommand> --help\` for examples.
`);

  agent
    .command("list")
    .description("List all agents in the fleet")
    .option("-c, --config <file>", "fleet.yaml path", "fleet.yaml")
    .addHelpText('after', `
Examples:
  # List all agents in the default fleet.yaml
  $ fleetmind agent list

  # List agents from a specific fleet file
  $ fleetmind agent list --config acme-fleet.yaml
`)
    .action((opts) => {
      try {
        const fleet = loadFleet(opts.config);
        for (const a of fleet.agents.list) {
          const role = a.orchestrator ? chalk.magenta("orchestrator") : "specialist";
          console.log(`  ${a.emoji} ${chalk.bold(a.name)} (${a.id}) — ${role}`);
        }
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }
    });

  agent
    .command("info <id>")
    .description("Show details for a specific agent")
    .option("-c, --config <file>", "fleet.yaml path", "fleet.yaml")
    .addHelpText('after', `
Examples:
  # Show full details for the pm-bot agent
  $ fleetmind agent info pm-bot

  # Show details for an agent from a specific fleet file
  $ fleetmind agent info forge --config acme-fleet.yaml
`)
    .action((id: string, opts) => {
      try {
        const fleet = loadFleet(opts.config);
        const a = fleet.getAgent(id);
        if (!a) {
          log.error(`Agent '${id}' not found. Available: ${fleet.agents.list.map((x) => x.id).join(", ")}`);
          process.exit(1);
        }

        const workspace = path.join(fleet.agents.defaults.workspace_base, `workspace-${a.id}`);
        const wsExists = fs.existsSync(workspace);
        const model = a.model ?? fleet.agents.defaults.model;
        const skills = a.skills.map((s) => s.name + (s.version ? `@${s.version}` : "")).join(", ") || "—";
        const plugins = (a.plugins ?? fleet.agents.defaults.plugins).join(", ") || "—";
        const canSend = a.agent_to_agent.can_send_to.join(", ") || "—";

        console.log();
        console.log(chalk.bold(`  ${a.emoji} ${a.name} (${a.id})`));
        console.log(`  Role:        ${a.orchestrator ? chalk.magenta("orchestrator") : "specialist"}`);
        console.log(`  Model:       ${model}`);
        console.log(`  Description: ${a.description || "—"}`);
        console.log(`  Slack:       ${a.slack.account_id}`);
        console.log(`  Skills:      ${skills}`);
        console.log(`  Plugins:     ${plugins}`);
        console.log(`  Can send to: ${canSend}`);
        console.log(`  Workspace:   ${workspace} (${wsExists ? chalk.green("exists") : chalk.red("not provisioned")})`);
        console.log();
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }
    });

  agent
    .command("connect")
    .description("SSM port-forward to a bot's gateway, with pre-flight health checks")
    .argument("<agent>", "Agent ID to connect to")
    .option("-f, --fleet <path>", "fleet.yaml path", "fleet.yaml")
    .option("--region <region>", "AWS region", "us-west-2")
    .option("-p, --port <port>", "Remote gateway port on the bot", "18789")
    .option("--local-port <port>", "Local port to bind (defaults to --port; bumps if busy)")
    .option("-y, --yes", "Skip the post-preflight confirmation prompt", false)
    .option("--skip-preflight", "Open the port-forward without running diagnostics first (use when SSM Run Command is misbehaving and you need the gateway UI to debug it)", false)
    .addHelpText('after', `
Requires AWS credentials with:
  - ssm:DescribeInstanceInformation  (to look up the bot by fleet/agent tag)
  - ssm:SendCommand                  (pre-flight diagnostics)
  - ssm:GetCommandInvocation         (read diagnostic output)
  - ssm:StartSession + StartPortForwardingSession  (the port-forward itself)

The AWS Session Manager plugin must be installed locally
(https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html).

Examples:
  # Connect to the PM bot's gateway (default port 18789)
  $ fleetmind agent connect pm

  # Custom remote port (fleet remapped gateway)
  $ fleetmind agent connect worker --port 18790

  # Skip diagnostics and just open the tunnel
  $ fleetmind agent connect pm --skip-preflight

  # Auto-confirm (no prompt)
  $ fleetmind agent connect pm --yes
`)
    .action(async (agentId: string, opts: {
      fleet: string;
      region: string;
      port: string;
      localPort?: string;
      yes: boolean;
      skipPreflight: boolean;
    }) => {
      try {
        const fleet = loadFleet(opts.fleet);
        const fleetName = fleet.fleet.name;
        const region = opts.region;
        const remotePort = parseInt(opts.port, 10);
        if (isNaN(remotePort) || remotePort <= 0 || remotePort > 65535) {
          throw new Error(`--port must be a valid TCP port number; got ${opts.port}`);
        }

        // Sanity: agent declared in fleet.yaml?
        const declared = fleet.agents.list.find((a) => a.id === agentId);
        if (!declared) {
          throw new Error(`Agent '${agentId}' not found in fleet '${fleetName}'. Run 'fleetmind agent list' to see available agents.`);
        }

        log.bold(`Looking up instance for agent ${agentId} in fleet ${fleetName}...`);
        const instanceId = await lookupInstanceId(fleetName, agentId, region);
        if (!instanceId) {
          throw new Error(
            `No SSM-registered instance found with tags fleetmind:fleet_name=${fleetName} fleetmind:agent_id=${agentId}. ` +
              `Either the bot hasn't bootstrapped, SSM agent isn't running, or the tags are wrong.`,
          );
        }
        log.dim(`  instance: ${instanceId}`);

        // ── Pre-flight diagnostics ─────────────────────────────────────────
        let preflightResult: PreflightResult = { dashboardUrl: null };
        if (!opts.skipPreflight) {
          preflightResult = await runPreflight(instanceId, agentId, region);
          if (!opts.yes) {
            // Tiny inline confirm (avoid pulling in prompts dep). Skip
            // confirmation if not a TTY (CI / scripted).
            if (process.stdin.isTTY) {
              process.stdout.write("Continue with port-forward? [Y/n] ");
              const answer = await readOneLine();
              if (answer.trim().toLowerCase() === "n" || answer.trim().toLowerCase() === "no") {
                log.info("Aborted.");
                return;
              }
            }
          }
        }

        // ── Pick local port ────────────────────────────────────────────────
        const requestedLocal = opts.localPort ? parseInt(opts.localPort, 10) : remotePort;
        const localPort = await findFreePort(requestedLocal);
        if (localPort !== requestedLocal) {
          log.warn(`Local port ${requestedLocal} busy; using ${localPort} instead.`);
        }

        // ── Spawn aws ssm start-session as foreground child ────────────────
        log.bold(`Opening port-forward...`);
        log.ok(`Gateway available at ws://localhost:${localPort}  (Ctrl+C to disconnect)`);

        // Print the tokenized dashboard URL when pre-flight captured one.
        // Rewrite the host to localhost:<local-port> so the operator can
        // copy-paste straight into a browser.
        if (preflightResult.dashboardUrl) {
          const rewritten = rewriteDashboardUrlForLocalhost(preflightResult.dashboardUrl, localPort);
          if (rewritten) {
            log.ok(`Dashboard:         ${chalk.cyan(rewritten.url)}`);
            if (rewritten.botPort !== remotePort) {
              log.warn(`  ⚠ Bot dashboard uses port ${rewritten.botPort} but we forwarded ${remotePort}.`);
              log.warn(`    Either re-run with --port ${rewritten.botPort}, or open a second port-forward.`);
            } else {
              log.dim(`  → token baked in; paste this URL in your browser`);
            }
          } else {
            log.dim(`  dashboard URL (could not rewrite for localhost): ${preflightResult.dashboardUrl}`);
          }
        }

        log.dim(`  → aws ssm start-session --target ${instanceId} --document-name AWS-StartPortForwardingSession ...`);

        const child = spawn(
          "aws",
          [
            "ssm", "start-session",
            "--target", instanceId,
            "--document-name", "AWS-StartPortForwardingSession",
            "--parameters", JSON.stringify({ portNumber: [String(remotePort)], localPortNumber: [String(localPort)] }),
            "--region", region,
          ],
          { stdio: "inherit" },
        );

        // Propagate Ctrl+C cleanly to the AWS CLI so the session terminates
        // server-side rather than orphaning a port-forward.
        const forwardSignal = (sig: NodeJS.Signals) => {
          if (!child.killed) child.kill(sig);
        };
        process.on("SIGINT", () => forwardSignal("SIGINT"));
        process.on("SIGTERM", () => forwardSignal("SIGTERM"));

        child.on("exit", (code, signal) => {
          if (signal === "SIGINT" || signal === "SIGTERM") {
            log.info(`Session closed.`);
          } else if (code !== 0) {
            log.error(`aws ssm start-session exited with code ${code}.`);
            process.exit(code ?? 1);
          }
        });
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// agent connect helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Optional return value from preflight — surfaces the bot's dashboard URL
 *  so the caller can rewrite the host to localhost and print it alongside
 *  the port-forward output. dashboardUrl is null when the dashboard command
 *  failed or wasn't available on the bot. */
interface PreflightResult {
  dashboardUrl: string | null;
}

async function runPreflight(
  instanceId: string,
  agentId: string,
  region: string,
): Promise<PreflightResult> {
  log.bold(`Pre-flight diagnostics...`);
  const ssm = new SSMClient({ region });

  // Bundle shell snippets in one SSM Run Command for round-trip efficiency.
  // Output is parsed by markers so we can format each section.
  // 'openclaw dashboard --no-open' is run as ec2-user (the gateway's user) so
  // it picks up the gateway auth token from the gateway's own config and
  // embeds it in the printed URL.
  const commands = [
    `set +e`,
    `echo "::SERVICE::"`,
    `systemctl is-active openclaw-${agentId} || true`,
    `echo "::SINCE::"`,
    `systemctl show -p ActiveEnterTimestamp --value openclaw-${agentId} 2>/dev/null || true`,
    `echo "::VERSION::"`,
    `openclaw --version 2>/dev/null | head -1 || echo "<openclaw CLI not on PATH>"`,
    `echo "::LOG::"`,
    `journalctl -u openclaw-${agentId} -n 5 --no-pager 2>/dev/null || true`,
    `echo "::DASHBOARD::"`,
    `sudo -u ec2-user openclaw dashboard --no-open 2>&1 | grep -oE 'http[s]?://[^[:space:]]+' | head -1 || true`,
    `echo "::END::"`,
  ];

  try {
    const send = await ssm.send(new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: "AWS-RunShellScript",
      Parameters: { commands },
    }));
    const cmdId = send.Command?.CommandId;
    if (!cmdId) {
      log.warn(`  pre-flight: no SSM CommandId returned; skipping diagnostics`);
      return { dashboardUrl: null };
    }

    // Poll up to 15s; pre-flight should be fast.
    const deadline = Date.now() + 15_000;
    let inv;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      inv = await ssm.send(new GetCommandInvocationCommand({
        CommandId: cmdId,
        InstanceId: instanceId,
      }));
      const status = inv.Status ?? "Pending";
      if (["Success", "Failed", "TimedOut", "Cancelled"].includes(status)) break;
    }

    if (!inv) {
      log.warn(`  pre-flight: timed out waiting for SSM response; proceeding to port-forward anyway`);
      return { dashboardUrl: null };
    }

    if (inv.Status !== "Success") {
      log.warn(`  pre-flight: SSM Run Command ${inv.Status}; proceeding to port-forward anyway`);
      if (inv.StandardErrorContent) log.dim(`    ${inv.StandardErrorContent.trim().split("\n").join("\n    ")}`);
      return { dashboardUrl: null };
    }

    const out = inv.StandardOutputContent ?? "";
    const sections = parsePreflightOutput(out);

    // Service status — coloured by state
    const serviceLine = sections.service.trim() || "<unknown>";
    if (serviceLine === "active") {
      log.ok(`  service:  ${chalk.green("active")}`);
    } else {
      log.warn(`  service:  ${chalk.yellow(serviceLine)}`);
    }

    // Since (last restart)
    log.dim(`  since:    ${sections.since.trim() || "<unknown>"}`);

    // Version
    log.dim(`  version:  ${sections.version.trim() || "<unknown>"}`);

    // Recent log lines
    if (sections.log.trim()) {
      log.dim(`  recent log:`);
      for (const line of sections.log.trim().split("\n").slice(-5)) {
        log.dim(`    ${line}`);
      }
    } else {
      log.dim(`  recent log: <empty>`);
    }

    return { dashboardUrl: sections.dashboard.trim() || null };
  } catch (err) {
    log.warn(`  pre-flight: ${String(err)}; proceeding to port-forward anyway`);
    return { dashboardUrl: null };
  }
}

function parsePreflightOutput(raw: string): { service: string; since: string; version: string; log: string; dashboard: string } {
  const sections = { service: "", since: "", version: "", log: "", dashboard: "" };
  const markers = ["::SERVICE::", "::SINCE::", "::VERSION::", "::LOG::", "::DASHBOARD::", "::END::"];
  const indices = markers.map((m) => raw.indexOf(m)).map((i) => (i < 0 ? raw.length : i));
  sections.service = raw.slice(indices[0] + markers[0].length, indices[1]);
  sections.since = raw.slice(indices[1] + markers[1].length, indices[2]);
  sections.version = raw.slice(indices[2] + markers[2].length, indices[3]);
  sections.log = raw.slice(indices[3] + markers[3].length, indices[4]);
  sections.dashboard = raw.slice(indices[4] + markers[4].length, indices[5]);
  return sections;
}

/** Rewrite a bot-side dashboard URL (e.g. http://127.0.0.1:18789/chat?...&token=...)
 *  so the host points at the operator's local-forwarded port. Returns the
 *  rewritten URL + the bot's original port (so the caller can warn on port
 *  mismatch), or null if the input doesn't look like a localhost URL. */
function rewriteDashboardUrlForLocalhost(
  botUrl: string,
  localPort: number,
): { url: string; botPort: number } | null {
  try {
    const parsed = new URL(botUrl);
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") return null;
    const botPort = parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80;
    parsed.hostname = "localhost";
    parsed.port = String(localPort);
    return { url: parsed.toString(), botPort };
  } catch {
    return null;
  }
}

/** Find an available local TCP port starting at `start`, scanning forward. */
async function findFreePort(start: number, maxAttempts = 20): Promise<number> {
  for (let p = start; p < start + maxAttempts; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free local port in range ${start}–${start + maxAttempts - 1}.`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, "127.0.0.1");
  });
}

/** Read a single line from stdin (synchronous-feeling, async under the hood). */
function readOneLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const newlineIdx = buf.indexOf("\n");
      if (newlineIdx >= 0) {
        process.stdin.off("data", onData);
        process.stdin.pause();
        resolve(buf.slice(0, newlineIdx));
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}
