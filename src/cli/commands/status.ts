import { Command } from "commander";
import fs from "node:fs";
import chalk from "chalk";
import { loadFleet } from "../../config/loader.js";
import { standardWorkspaceBase } from "../../core/model.js";
import { log } from "../../utils/log.js";

export function registerStatus(program: Command): void {
  program
    .command("status [fleet]")
    .option("-f, --fleet <path>", "fleet.yaml path (overrides positional arg and FLEET_YAML env var)")
    .description("Show fleet configuration and workspace status")
    .addHelpText('after', `
Examples:
  # Show status for the default fleet.yaml
  $ fleetmind status

  # Show status for a specific fleet file
  $ fleetmind status acme-fleet.yaml
`)
    .action((fleetArg: string | undefined, opts) => {
      const fleetFile = opts.fleet ?? fleetArg ?? "fleet.yaml";
      try {
        const fleet = loadFleet(fleetFile);
        const { fleet: meta, agents } = fleet;

        console.log(chalk.bold(`\n  Fleet: ${meta.name} v${meta.version}`));
        if (meta.client) console.log(`  Client: ${meta.client}`);
        if (meta.description) console.log(`  ${meta.description}`);
        console.log();

        // Header
        const col = (s: string, w: number) => s.padEnd(w).slice(0, w);
        console.log(chalk.bold(
          `  ${col("Agent", 18)} ${col("Role", 14)} ${col("Skills", 30)} ${col("Workspace", 10)}`
        ));
        console.log("  " + "─".repeat(76));

        for (const agent of agents.list) {
          const workspace = standardWorkspaceBase(fleet.targetForAgent(agent));
          const wsOk = fs.existsSync(workspace);
          const wsStatus = wsOk ? chalk.green("✓") : chalk.red("✗");
          const role = agent.orchestrator
            ? chalk.magenta("orchestrator")
            : "specialist";
          const skills = agent.skills
            .map((s) => s.name + (s.version ? `@${s.version}` : ""))
            .join(", ") || "—";

          console.log(
            `  ${col(`${agent.emoji} ${agent.name}`, 18)} ${col(role, 14)} ${col(skills, 30)} ${wsStatus}`
          );
        }
        console.log();
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }
    });
}
