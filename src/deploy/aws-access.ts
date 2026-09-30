import type { Fleet } from "../config/schema.js";
import { RuntimeAwsAccess, type RuntimeAwsAccessConfig } from "../config/aws-access.js";
import { AWS_ACCESS_PATH } from "../runtime/aws-access.js";

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

/** Runs as SSM root, independently of user workspace bundles. Never promote a
 * writable workspace file into trusted configuration. Identical sync is a no-op. */
export function accessSyncCommand(catalog: RuntimeAwsAccessConfig | null, version: string): string {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error("Pin FleetMind runtime version for AWS access sync");
  const body = catalog ? JSON.stringify(RuntimeAwsAccess.parse(catalog), null, 2) + "\n" : null;
  if (body && Buffer.byteLength(body) > 65536) throw new Error("AWS access catalog exceeds 64 KiB");
  return [
    "set -eu",
    `[ "$(id -u)" = 0 ]`,
    `[ "$(fleetmind --version)" = '${version}' ] || { echo 'FleetMind runtime/module release must match before AWS access sync' >&2; exit 1; }`,
    `[ ! -L /etc/fleetmind ]`,
    "install -d -o root -g root -m 0755 /etc/fleetmind",
    ...(body ? [
      'tmp=$(mktemp /etc/fleetmind/.aws-access.XXXXXX)',
      "trap 'rm -f \"$tmp\"' EXIT",
      `printf '%s' '${Buffer.from(body).toString("base64")}' | base64 -d > "$tmp"`,
      'chown root:root "$tmp"; chmod 0644 "$tmp"',
      `if [ ! -L ${AWS_ACCESS_PATH} ] && [ -f ${AWS_ACCESS_PATH} ] && [ "$(stat -c '%u:%g:%a' ${AWS_ACCESS_PATH})" = '0:0:644' ] && cmp -s "$tmp" ${AWS_ACCESS_PATH}; then exit 0; fi`,
      `mv -fT "$tmp" ${AWS_ACCESS_PATH}`,
    ] : [`rm -f ${AWS_ACCESS_PATH}`]),
  ].join("\n");
}
