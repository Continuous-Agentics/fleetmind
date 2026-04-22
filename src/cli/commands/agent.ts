import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { loadFleet } from "../../config/loader.js";
import { log } from "../../utils/log.js";

export function registerAgent(program: Command): void {
  const agent = program
    .command("agent")
    .description("Manage individual agents");

  agent
    .command("list")
    .description("List all agents in the fleet")
    .option("-c, --config <file>", "fleet.yaml path", "fleet.yaml")
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
}
