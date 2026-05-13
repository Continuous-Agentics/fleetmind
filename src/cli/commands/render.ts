import { Command } from "commander";
import { loadFleet } from "../../config/loader.js";
import { writeOutputs } from "../../runtime/renderer.js";
import { log } from "../../utils/log.js";

export function registerRender(program: Command): void {
  program
    .command("render [fleet]")
    .option("-f, --fleet <path>", "fleet.yaml path (overrides positional arg and FLEET_YAML env var)")
    .description("Render openclaw.json and terraform vars without deploying")
    .option("-o, --out <dir>", "Output base directory", ".")
    .addHelpText('after', `
Examples:
  # Render openclaw.json + terraform vars for the default fleet.yaml
  $ fleetmind render

  # Render a specific fleet file
  $ fleetmind render acme-fleet.yaml

  # Write rendered outputs to a custom directory
  $ fleetmind render --out ./build

  # Render a named fleet file into a custom output dir
  $ fleetmind render staging-fleet.yaml --out ./rendered-staging
`)
    .action((fleetArg: string | undefined, opts) => {
      const fleetFile = opts.fleet ?? fleetArg ?? "fleet.yaml";
      try {
        const fleet = loadFleet(fleetFile);
        const written = writeOutputs(fleet, opts.out);

        log.bold(`Rendered outputs for fleet ${fleet.fleet.name}:`);
        for (const [name, p] of Object.entries(written)) {
          log.ok(`${name}: ${p}`);
        }
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }
    });
}
