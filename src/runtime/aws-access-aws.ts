import { fromInstanceMetadata } from "@smithy/credential-provider-imds";
import { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { authorizeTask, executeTask, readAccessCatalog, type AccessDeps } from "./aws-access.js";

export interface AuthorizationOptions {
  deadlineMs?: number;
  requestTimeoutMs?: number;
  source?: AccessDeps["source"];
  readCatalog?: AccessDeps["readCatalog"];
  audit?: AccessDeps["audit"];
}

/** One deadline covers IMDS, all STS requests, retries and response consumption.
 * Promise race also bounds a stalled provider/body that fails to honor abort. */
export async function withAwsAuthorization<T>(work: (deps: AccessDeps) => Promise<T>, options: AuthorizationOptions = {}): Promise<T> {
  const controller = new AbortController();
  const clients = new Set<STSClient>();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      for (const client of clients) client.destroy();
      reject(new Error("AWS authorization deadline exceeded"));
    }, options.deadlineMs ?? 30_000);
  });
  const client = (credentials: Awaited<ReturnType<AccessDeps["source"]>>, region: string) => {
    if (controller.signal.aborted) throw new Error("AWS authorization aborted");
    const sts = new STSClient({ credentials, region, endpoint: `https://sts.${region}.amazonaws.com`, maxAttempts: 2,
      requestHandler: new NodeHttpHandler({ connectionTimeout: 3000, requestTimeout: options.requestTimeoutMs ?? 10_000,
        throwOnRequestTimeout: true }) });
    clients.add(sts);
    return sts;
  };
  const deps: AccessDeps = {
    readCatalog: options.readCatalog ?? readAccessCatalog,
    source: options.source ?? fromInstanceMetadata({ ec2MetadataV1Disabled: true, timeout: 1000, maxRetries: 1,
      logger: { debug() {}, info() {}, warn() {}, error() {} } }),
    identity: async (credentials, region) => {
      const sts = client(credentials, region);
      try { return await sts.send(new GetCallerIdentityCommand({}), { abortSignal: controller.signal }); }
      finally { sts.destroy(); clients.delete(sts); }
    },
    assume: async (credentials, region, role, session, duration) => {
      const sts = client(credentials, region);
      try {
        const output = await sts.send(new AssumeRoleCommand({ RoleArn: role, RoleSessionName: session, DurationSeconds: duration }), { abortSignal: controller.signal });
        return { accessKeyId: output.Credentials?.AccessKeyId ?? "", secretAccessKey: output.Credentials?.SecretAccessKey ?? "",
          sessionToken: output.Credentials?.SessionToken, expiration: output.Credentials?.Expiration };
      } finally { sts.destroy(); clients.delete(sts); }
    },
    audit: options.audit ?? (event => process.stderr.write(JSON.stringify(event) + "\n")),
    now: Date.now,
  };
  const active = () => { if (controller.signal.aborted) throw new Error("AWS authorization aborted"); };
  const readCatalog = deps.readCatalog;
  const source = deps.source;
  const audit = deps.audit;
  deps.readCatalog = () => { active(); return readCatalog(); };
  deps.source = async () => { active(); const value = await source(); active(); return value; };
  // A late response/body cannot authorize a task after its deadline.
  deps.audit = event => { if (event.event === "aws-access.authorized") active(); audit(event); };
  try { return await Promise.race([work(deps), timeout]); }
  finally { clearTimeout(timer!); controller.abort(); for (const sts of clients) sts.destroy(); }
}

export async function runAwsTask(alias: string, command: string[], options: AuthorizationOptions = {}): Promise<number> {
  const result = await withAwsAuthorization(deps => authorizeTask(alias, deps), options);
  const exit = await executeTask(command, result.credentials, result.region);
  (options.audit ?? (e => process.stderr.write(JSON.stringify(e) + "\n")))({ event: "aws-access.completed", run: result.run, exit: String(exit) });
  return exit;
}
