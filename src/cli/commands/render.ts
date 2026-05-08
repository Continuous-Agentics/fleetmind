import { Command } from "commander";
import { loadFleet } from "../../config/loader.js";
import { writeOutputs } from "../../runtime/renderer.js";
import { log } from "../../utils/log.js";

export function registerRender(program: Command): void {
  program
    .command("render [fleet]")
    .description("Render openclaw.json and terraform vars without deploying")
    .option("-o, --out <dir>", "Output base directory", ".")
    .action((fleetArg: string | undefined, opts) => {
      const fleetFile = fleetArg ?? "fleet.yaml";
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
