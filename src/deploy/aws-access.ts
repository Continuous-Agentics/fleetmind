import type { Fleet } from "../config/schema.js";
import { AwsAccessHost, RuntimeAwsAccess, type AwsAccessHostConfig, type RuntimeAwsAccessConfig } from "../config/aws-access.js";
import { ACCESS_CAPABILITY, validatePublication } from "../runtime/aws-access-publication.js";

/** Only this agent's grants reach its host. No complete fleet catalog or peer grants. */
export function agentAccessCatalog(fleet: Fleet, agentId: string): RuntimeAwsAccessConfig | null {
  const agent = fleet.getAgent(agentId);
  if (!agent) throw new Error("Unknown agent");
  if (!agent.aws_access) return null;
  const host = fleet.targetForAgent(agent);
  if (host.provider !== "aws-ssm") throw new Error("AWS access requires an AWS host");
  return RuntimeAwsAccess.parse({ version: 1, agent: agent.id,
    source_role_arn: agent.aws_access.source_role_arn, source_region: host.aws.region,
    targets: Object.fromEntries(agent.aws_access.targets.map(alias => [alias, fleet.aws_access?.[alias]])),
  });
}

/** Host binding remains present when all grants are revoked. Never derive it from the catalog. */
export function agentAccessHost(fleet: Fleet, agentId: string): AwsAccessHostConfig {
  const agent = fleet.getAgent(agentId);
  if (!agent) throw new Error("Unknown agent");
  const target = fleet.targetForAgent(agent);
  if (target.provider !== "aws-ssm") throw new Error("AWS access requires an AWS host");
  return AwsAccessHost.parse({ fleet: fleet.fleet.name, agent: agent.id, account_id: target.aws.account_id,
    role_arn: target.aws.workload_role_arn, region: target.aws.region });
}

/** Root helper is capability-gated separately from the package version. The new
 * process drops ambient SDK/process overrides before any SDK is initialized. */
export function accessSyncCommand(catalog: RuntimeAwsAccessConfig | null, version: string, host: AwsAccessHostConfig): string {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error("Pin FleetMind runtime version for AWS access sync");
  validatePublication(catalog, host);
  const payload = Buffer.from(JSON.stringify({ host, catalog })).toString("base64");
  if (Buffer.byteLength(JSON.stringify(catalog)) > 65536) throw new Error("AWS access catalog exceeds 64 KiB");
  const clean = "env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent/fleetmind-aws-access LANG=C.UTF-8";
  return ["set -eu", '[ "$(id -u)" = 0 ]',
    `[ "$(${clean} fleetmind --version)" = '${version}' ] || { echo 'FleetMind runtime/module release must match before AWS access sync' >&2; exit 1; }`,
    `[ "$(${clean} fleetmind aws-access capability)" = '${ACCESS_CAPABILITY}' ] || { echo 'Required AWS access helper capability absent' >&2; exit 1; }`,
    `${clean} fleetmind aws-access publish '${payload}'`,
  ].join("\n");
}
