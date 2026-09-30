import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { SSMClient, DescribeInstanceInformationCommand, SendCommandCommand } from "@aws-sdk/client-ssm";
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { IAMClient, GetInstanceProfileCommand } from "@aws-sdk/client-iam";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { AwsAccessRevision, type AwsAccessHostConfig, type RuntimeAwsAccessConfig } from "../config/aws-access.js";
import { validatePublication } from "../runtime/aws-access-publication.js";
import { accessSyncCommand } from "./aws-access.js";

/** Resolve operator credentials once. The immutable result is used by STS,
 * SSM, EC2 and IAM in exactly one verified account/region context. */
export async function syncAccess(host: AwsAccessHostConfig, catalog: RuntimeAwsAccessConfig | null, version: string, revision: number): Promise<string> {
  validatePublication(catalog, host);
  AwsAccessRevision.parse(revision);
  const controller = new AbortController();
  const clients: Array<{ destroy(): void }> = [];
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    controller.abort(); for (const client of clients) client.destroy(); reject(new Error("AWS access sync deadline exceeded"));
  }, 60_000); });
  const work = async () => {
    const credentials = Object.freeze({ ...await defaultProvider()() });
    if (controller.signal.aborted) throw new Error("AWS access sync aborted");
    if (credentials.expiration && credentials.expiration.getTime() <= Date.now() + 60_000) throw new Error("Operator credentials expire too soon");
    const settings = { credentials, region: host.region, maxAttempts: 2 };
    const handler = () => new NodeHttpHandler({ connectionTimeout: 3000, requestTimeout: 10_000, throwOnRequestTimeout: true });
    const sts = new STSClient({ ...settings, endpoint: `https://sts.${host.region}.amazonaws.com`, requestHandler: handler() });
    const ssm = new SSMClient({ ...settings, endpoint: `https://ssm.${host.region}.amazonaws.com`, requestHandler: handler() });
    const ec2 = new EC2Client({ ...settings, endpoint: `https://ec2.${host.region}.amazonaws.com`, requestHandler: handler() });
    const iam = new IAMClient({ ...settings, region: "us-east-1", endpoint: "https://iam.amazonaws.com", requestHandler: handler() });
    clients.push(sts, ssm, ec2, iam);
    const options = { abortSignal: controller.signal };
    const identity = await sts.send(new GetCallerIdentityCommand({}), options);
    if (identity.Account !== host.account_id || !identity.Arn?.startsWith(`arn:aws:`) || identity.Arn.split(":")[4] !== host.account_id) {
      throw new Error("Operator AWS account does not match expected host account");
    }
    const ids = new Set<string>();
    const tokens = new Set<string>();
    let token: string | undefined;
    do {
      const page = await ssm.send(new DescribeInstanceInformationCommand({ Filters: [
        { Key: "tag:fleetmind:fleet_name", Values: [host.fleet] }, { Key: "tag:fleetmind:agent_id", Values: [host.agent] },
      ], NextToken: token }), options);
      for (const instance of page.InstanceInformationList ?? []) {
        if (!instance.InstanceId || !/^i-[a-f0-9]+$/.test(instance.InstanceId)) throw new Error("Expected an EC2 managed host");
        ids.add(instance.InstanceId);
      }
      token = page.NextToken;
      if (token && tokens.has(token)) throw new Error("Repeated discovery pagination token");
      if (token) tokens.add(token);
    } while (token);
    if (ids.size !== 1) throw new Error("Expected exactly one managed host across all discovery pages");
    const instanceId = [...ids][0];
    const described = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }), options);
    const reservations = described.Reservations ?? [];
    const instances = reservations.flatMap(r => r.Instances ?? []);
    if (described.NextToken || reservations.length !== 1 || reservations[0].OwnerId !== host.account_id || instances.length !== 1) throw new Error("Ambiguous EC2 host ownership");
    const instance = instances[0];
    const tags = (name: string) => (instance.Tags ?? []).filter(t => t.Key === name).map(t => t.Value);
    if (instance.InstanceId !== instanceId || instance.State?.Name !== "running" ||
        JSON.stringify(tags("fleetmind:fleet_name")) !== JSON.stringify([host.fleet]) ||
        JSON.stringify(tags("fleetmind:agent_id")) !== JSON.stringify([host.agent])) throw new Error("EC2 fleet/agent identity mismatch");
    const profileArn = instance.IamInstanceProfile?.Arn;
    if (!profileArn || !new RegExp(`^arn:aws:iam::${host.account_id}:instance-profile/[A-Za-z0-9+=,.@_/-]+$`).test(profileArn)) throw new Error("Unexpected host instance profile");
    const profile = await iam.send(new GetInstanceProfileCommand({ InstanceProfileName: profileArn.split("/").at(-1) }), options);
    if (profile.InstanceProfile?.Arn !== profileArn || profile.InstanceProfile.Roles?.length !== 1 || profile.InstanceProfile.Roles[0].Arn !== host.role_arn) throw new Error("Host workload role mismatch");
    if (controller.signal.aborted) throw new Error("AWS access sync aborted");
    const sent = await ssm.send(new SendCommandCommand({ InstanceIds: [instanceId], DocumentName: "AWS-RunShellScript",
      Parameters: { commands: [accessSyncCommand(catalog, version, host, revision)] } }), options);
    if (!sent.Command?.CommandId) throw new Error("Missing SSM submission receipt");
    return sent.Command.CommandId;
  };
  try { return await Promise.race([work(), timeout]); }
  finally { clearTimeout(timer!); controller.abort(); for (const client of clients) client.destroy(); }
}
