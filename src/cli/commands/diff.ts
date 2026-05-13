import { Command } from "commander";
import chalk from "chalk";
import { loadFleet } from "../../config/loader.js";
import { diffFleet } from "../../runtime/provisioner.js";
import { log } from "../../utils/log.js";

export function registerDiff(program: Command): void {
  program
    .command("diff [fleet]")
    .option("-f, --fleet <path>", "fleet.yaml path (overrides positional arg and FLEET_YAML env var)")
    .description("Show what deploy would change without applying anything")
    .addHelpText('after', `
Examples:
  # Diff the default fleet.yaml against what's in ./rendered/
  $ fleetmind diff

  # Diff a specific fleet file
  $ fleetmind diff acme-fleet.yaml

  # Typical workflow: diff first, then deploy if changes look right
  $ fleetmind diff && fleetmind deploy
`)
    .action((fleetArg: string | undefined, opts) => {
      const fleetFile = opts.fleet ?? fleetArg ?? "fleet.yaml";
      try {
        const fleet = loadFleet(fleetFile);
        const changes = diffFleet(fleet);

        if (changes[0] === "No changes detected.") {
          log.ok("No changes detected.");
          return;
        }

        log.bold(`Changes (${changes.length}):`);
        for (const c of changes) {
          if (c.startsWith("[+]")) console.log(chalk.green("  " + c));
          else if (c.startsWith("[~]")) console.log(chalk.yellow("  " + c));
          else if (c.startsWith("[-]")) console.log(chalk.red("  " + c));
          else console.log("  " + c);
        }
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }
    });
}
