import { Command } from "commander";
import { loadFleet } from "../../config/loader.js";
import { provisionFleet } from "../../runtime/provisioner.js";
import { writeOutputs } from "../../runtime/renderer.js";
import { log } from "../../utils/log.js";

export function registerDeploy(program: Command): void {
  program
    .command("deploy [fleet]")
    .description("Provision agent workspaces and render openclaw.json")
    .option("--dry-run", "Show what would happen without doing it")
    .option("--no-render", "Skip rendering openclaw.json")
    .action((fleetArg: string | undefined, opts) => {
      const fleetFile = fleetArg ?? "fleet.yaml";
      try {
        const fleet = loadFleet(fleetFile);
        provisionFleet(fleet, opts.dryRun ?? false);

        if (opts.render !== false && !opts.dryRun) {
          const written = writeOutputs(fleet);
          for (const [name, p] of Object.entries(written)) {
            log.ok(`Rendered ${name} → ${p}`);
          }
        }

        if (!opts.dryRun) {
          log.dim("\nTip: run `openclaw gateway restart` to apply the new config.");
        }
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }
    });
}
