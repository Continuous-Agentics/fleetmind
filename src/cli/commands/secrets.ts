import { Command } from "commander";
import chalk from "chalk";
import { saveSecret, listSecretKeys, exportSecrets } from "../../utils/secrets.js";
import { log } from "../../utils/log.js";

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
}
