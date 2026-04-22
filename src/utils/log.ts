/**
 * Minimal logger with chalk colors.
 */
import chalk from "chalk";

export const log = {
  info: (msg: string) => console.log(msg),
  ok: (msg: string) => console.log(`${chalk.green("✓")} ${msg}`),
  warn: (msg: string) => console.log(`${chalk.yellow("⚠")} ${msg}`),
  error: (msg: string) => console.error(`${chalk.red("✗")} ${msg}`),
  step: (msg: string) => console.log(`  ${chalk.cyan("→")} ${msg}`),
  success: (msg: string) => console.log(chalk.green(msg)),
  dim: (msg: string) => console.log(chalk.dim(msg)),
  bold: (msg: string) => console.log(chalk.bold(msg)),
};
