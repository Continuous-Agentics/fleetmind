import { Command } from "commander";
import { loadFleet } from "../../config/loader.js";
import { SkillsWatcher } from "../../runtime/watcher.js";
import { log } from "../../utils/log.js";

export function registerWatch(program: Command): void {
  program
    .command("watch [fleet]")
    .description("GitOps watcher — auto-push skill updates from the skills repo")
    .option("--interval <interval>", "Poll interval (e.g. 30s, 5m)")
    .action(async (fleetArg: string | undefined, opts) => {
      const fleetFile = fleetArg ?? "fleet.yaml";
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
