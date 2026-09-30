/** Private runner: CLI launches with a clean environment before loading the SDK. */
import { runAwsTask } from "./aws-access-aws.js";
try {
  const [alias, ...command] = process.argv.slice(2);
  if (!alias || !command.length) throw new Error("Missing target or command");
  process.exitCode = await runAwsTask(alias, command);
} catch {
  process.stderr.write("AWS access runner stopped; no host credential fallback attempted.\n");
  process.exitCode = 1;
}
