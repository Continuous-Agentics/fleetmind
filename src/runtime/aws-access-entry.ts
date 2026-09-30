/** Private task runner. The CLI starts this module with a clean environment,
 * before the SDK reads config. It never writes credentials to stdout or disk. */
import { fromInstanceMetadata } from "@smithy/credential-provider-imds";
import { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { authorizeTask, executeTask, readAccessCatalog, type Credentials } from "./aws-access.js";

const client = (credentials: Credentials, region: string) => new STSClient({
  credentials, region, endpoint: `https://sts.${region}.amazonaws.com`,
  maxAttempts: 2, requestHandler: new NodeHttpHandler({ connectionTimeout: 3000, requestTimeout: 10000 }),
});

try {
  const [alias, ...command] = process.argv.slice(2);
  if (!alias || !command.length) throw new Error("Missing target or command");
  const result = await authorizeTask(alias, {
    readCatalog: readAccessCatalog,
    source: fromInstanceMetadata({ ec2MetadataV1Disabled: true, timeout: 1000, maxRetries: 1,
      logger: { debug() {}, info() {}, warn() {}, error() {} } }),
    identity: async (credentials, region) => {
      const sts = client(credentials, region);
      try { return await sts.send(new GetCallerIdentityCommand({})); } finally { sts.destroy(); }
    },
    assume: async (credentials, region, role, session, duration) => {
      const sts = client(credentials, region);
      try {
        const output = await sts.send(new AssumeRoleCommand({ RoleArn: role, RoleSessionName: session, DurationSeconds: duration }));
        return { accessKeyId: output.Credentials?.AccessKeyId ?? "", secretAccessKey: output.Credentials?.SecretAccessKey ?? "",
          sessionToken: output.Credentials?.SessionToken, expiration: output.Credentials?.Expiration };
      } finally { sts.destroy(); }
    },
    audit: event => process.stderr.write(JSON.stringify(event) + "\n"),
    now: Date.now,
  });
  process.exitCode = await executeTask(command, result.credentials, result.region);
  process.stderr.write(JSON.stringify({ event: "aws-access.completed", run: result.run, exit: process.exitCode }) + "\n");
} catch {
  process.stderr.write("AWS access runner stopped; no host credential fallback attempted.\n");
  process.exitCode = 1;
}
