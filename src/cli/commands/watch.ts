import { Command } from "commander";
import { loadFleet } from "../../config/loader.js";
import { SkillsWatcher } from "../../runtime/watcher.js";
import { log } from "../../utils/log.js";

export function registerWatch(program: Command): void {
  program
    .command("watch [fleet]")
    .option("-f, --fleet <path>", "fleet.yaml path (overrides positional arg and FLEET_YAML env var)")
    .description("GitOps watcher — auto-push skill updates from the skills repo")
    .option("--interval <interval>", "Poll interval (e.g. 30s, 5m)")
    .addHelpText('after', `
Examples:
  # Watch the default fleet.yaml and auto-push skill changes
  $ fleetmind watch

  # Watch a specific fleet file
  $ fleetmind watch acme-fleet.yaml

  # Override the poll interval to every 2 minutes
  $ fleetmind watch --interval 2m
`)
    .action(async (fleetArg: string | undefined, opts) => {
      const fleetFile = opts.fleet ?? fleetArg ?? "fleet.yaml";
      try {
        const fleet = loadFleet(fleetFile);
        if (opts.interval) fleet.skills_repo.poll_interval = opts.interval;

        const watcher = new SkillsWatcher(fleet);
        await watcher.watch();
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }
    });
}
