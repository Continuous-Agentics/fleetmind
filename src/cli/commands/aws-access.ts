import { Command } from "commander";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadFleet } from "../../config/loader.js";
import { cleanAccessEnvironment } from "../../runtime/aws-access.js";
import { agentAccessCatalog, accessSyncCommand } from "../../deploy/aws-access.js";
import { transportFor } from "../../deploy/factory.js";

export function registerAwsAccess(program: Command): void {
  const access = program.command("aws-access").description("Explicit scoped application-account tasks (not host-service credentials)");
  access.command("exec <target> <command...>")
    .description("Run a command under an allowed target role; use -- before the command")
    .action(async (target: string, command: string[]) => {
      // New process, clean env BEFORE SDK initialization. No global env edits,
      // shared ~/.aws files, secret injection, fleet.yaml or --role overrides.
      const child = spawn(process.execPath, [fileURLToPath(new URL("../../runtime/aws-access-entry.js", import.meta.url)), target, ...command], {
        env: cleanAccessEnvironment(process.env), stdio: "inherit", shell: false,
      });
      const interrupt = () => child.kill("SIGINT");
      const terminate = () => child.kill("SIGTERM");
      process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
      child.once("error", () => { process.stderr.write("AWS access runner could not start\n"); process.exitCode = 1; });
      child.once("exit", code => {
        process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.exitCode = code ?? 1;
      });
    });
  access.command("sync")
    .description("Operator: submit independent root-owned catalog sync via existing SSM (no restart/replacement)")
    .option("--fleet <path>", "Operator fleet YAML", "fleet.yaml")
    .option("--agent <id>", "Sync only one agent")
    .option("--dry-run", "Print catalog and commands without AWS calls", false)
    .action(async (opts: { fleet: string; agent?: string; dryRun: boolean }) => {
      try {
        const fleet = loadFleet(opts.fleet);
        if (opts.agent && !fleet.getAgent(opts.agent)) throw new Error("Unknown agent");
        for (const agent of fleet.agents.list.filter(a => !opts.agent || a.id === opts.agent)) {
          const host = fleet.targetForAgent(agent);
          if (host.provider !== "aws-ssm") continue;
          const command = accessSyncCommand(agentAccessCatalog(fleet, agent.id), program.version()!);
          if (opts.dryRun) { console.log(`# ${agent.id}\n${command}`); continue; }
          const { resolver, runner } = transportFor("aws-ssm", { fleetName: fleet.fleet.name, region: host.aws.region });
          const instance = await resolver.resolveHost(agent.id);
          if (!instance) throw new Error(`No host found for ${agent.id}`);
          const id = await runner.run(instance, [command]);
          console.log(`${agent.id}: catalog sync submitted ${id} (verify SSM command completion; submission is not success)`);
        }
      } catch (err) { console.error(String(err)); process.exitCode = 1; }
    });
}
