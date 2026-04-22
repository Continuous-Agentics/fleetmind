import { Command } from "commander";
import { loadFleet } from "../../config/loader.js";
import { SkillsWatcher } from "../../runtime/watcher.js";
import { log } from "../../utils/log.js";

export function registerPush(program: Command): void {
  const push = program
    .command("push")
    .description("Push skills or plugins to agents");

  push
    .command("skill <name>")
    .description("Push a skill to one or more agents")
    .option("-c, --config <file>", "fleet.yaml path", "fleet.yaml")
    .option("-a, --agent <id>", "Target agent ID")
    .option("--all", "Push to all agents")
    .option("-v, --version <ver>", "Skill version to install")
    .action((skillName: string, opts) => {
      try {
        const fleet = loadFleet(opts.config);
        const watcher = new SkillsWatcher(fleet);

        const targets = opts.all
          ? fleet.agents.list.map((a) => a.id)
          : opts.agent
          ? [opts.agent as string]
          : null;

        if (!targets) {
          log.error("Specify --agent <id> or --all");
          process.exit(1);
        }

        let ok = true;
        for (const id of targets) {
          if (!watcher.pushSkill(id, skillName)) ok = false;
        }
        if (!ok) process.exit(1);
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }
    });

  push
    .command("plugin <name>")
    .description("Push a plugin to one or more agents (updates fleet config)")
    .option("-c, --config <file>", "fleet.yaml path", "fleet.yaml")
    .option("-a, --agent <id>", "Target agent ID")
    .option("--all", "Push to all agents")
    .action((pluginName: string, opts) => {
      try {
        const fleet = loadFleet(opts.config);

        const targets = opts.all
          ? fleet.agents.list
          : opts.agent
          ? [fleet.getAgent(opts.agent as string)].filter(Boolean)
          : null;

        if (!targets) {
          log.error("Specify --agent <id> or --all");
          process.exit(1);
        }

        for (const agent of targets) {
          if (!agent) continue;
          const plugins = agent.plugins ?? fleet.agents.defaults.plugins;
          if (!plugins.includes(pluginName)) {
            plugins.push(pluginName);
            log.ok(`Added plugin ${pluginName} to ${agent.emoji} ${agent.name}`);
          } else {
            log.dim(`Plugin ${pluginName} already in ${agent.name}`);
          }
        }
        log.dim("\nRun `fleetmind render` to update openclaw.json");
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }
    });
}
