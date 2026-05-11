import { Command } from "commander";
import chalk from "chalk";
import { saveSecret, listSecretKeys, exportSecrets } from "../../utils/secrets.js";
import { log } from "../../utils/log.js";
import { populateSecrets, printResults, loadEnvFile } from "./populate.js";

export function registerSecrets(program: Command): void {
  const secrets = program
    .command("secrets")
    .description("Manage fleet secrets");

  secrets
    .command("set <key> <value>")
    .description("Store a secret in the local secret store")
    .action((key: string, value: string) => {
      saveSecret(key, value);
      log.ok(`Secret ${chalk.bold(key)} stored.`);
    });

  secrets
    .command("list")
    .description("List stored secret keys (values never shown)")
    .action(() => {
      const keys = listSecretKeys();
      if (keys.length === 0) {
        log.dim("No secrets stored.");
        return;
      }
      log.bold("Stored secrets:");
      for (const k of keys) {
        console.log(`  ${chalk.cyan(k)} = ${chalk.dim("***")}`);
      }
    });

  secrets
    .command("export")
    .description("Export secrets as shell export statements")
    .action(() => {
      console.log(exportSecrets());
    });

  secrets
    .command("populate")
    .description("Push per-agent Slack + Anthropic credentials into AWS Secrets Manager")
    .option("-f, --fleet <path>", "Path to fleet.yaml", "fleet.yaml")
    .option("--dry-run", "Print what would be pushed without calling AWS", false)
    .option("--from <path>", "Load env vars from a .env-style file (does not override existing env)")
    .option("--agent <id>", "Populate only this agent (repeatable)", (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option("--region <region>", "AWS region (default: delegation.aws_region from fleet.yaml or AWS env)")
    .action(async (opts) => {
      try {
        const env: Record<string, string> = { ...process.env } as Record<string, string>;
        if (opts.from) {
          const fileEnv = loadEnvFile(opts.from);
          for (const [k, v] of Object.entries(fileEnv)) {
            if (!env[k]) env[k] = v;
          }
        }
        const results = await populateSecrets({
          fleet: opts.fleet,
          dryRun: opts.dryRun,
          from: opts.from,
          agent: opts.agent as string[],
          region: opts.region,
        });
        printResults(results, opts.dryRun, env);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(msg);
        process.exit(1);
      }
    });
}
