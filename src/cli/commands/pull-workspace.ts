/**
 * fleetmind pull-workspace — snapshot each bot's current workspace state to local disk.
 *
 * Symmetric inverse of `push fleet`. For each target agent:
 *   1. Send SSM command: tar workspace files → upload to S3 staging
 *   2. Download tarball from S3
 *   3. Extract to ./<out>/<agent>/
 *
 * Uses S3 staging (consistent with push fleet) so large files aren't
 * constrained by SSM output limits.
 *
 * Usage:
 *   fleetmind pull-workspace [--agent <id>] [--out <dir>] [--region <r>]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Command } from "commander";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { loadFleet } from "../../config/loader.js";
import { standardWorkspaceBase } from "../../core/model.js";
import { log } from "../../utils/log.js";

const DEFAULT_INCLUDE = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "MEMORY.md",
  "PATCHES.md",
  "fleet.yaml",
  "memory",
  "skills",
];

// ── SSM helpers ───────────────────────────────────────────────────────────────

async function sendSsmAndWait(
  instanceId: string,
  commands: string[],
  region: string,
  timeoutMs = 60_000
): Promise<{ stdout: string; stderr: string; status: string }> {
  const ssm = new SSMClient({ region });

  const send = await ssm.send(new SendCommandCommand({
    InstanceIds: [instanceId],
    DocumentName: "AWS-RunShellScript",
    Parameters: { commands },
  }));

  const cmdId = send.Command?.CommandId;
  if (!cmdId) throw new Error("SSM send command returned no CommandId");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const inv = await ssm.send(new GetCommandInvocationCommand({
      CommandId: cmdId,
      InstanceId: instanceId,
    }));
    const status = inv.Status ?? "Pending";
    if (["Success", "Failed", "TimedOut", "Cancelled"].includes(status)) {
      return {
        stdout: inv.StandardOutputContent ?? "",
        stderr: inv.StandardErrorContent ?? "",
        status,
      };
    }
  }
  throw new Error(`SSM command ${cmdId} timed out after ${timeoutMs}ms`);
}

export async function lookupInstanceId(
  fleetName: string,
  agentId: string,
  region: string
): Promise<string | null> {
  const ssm = new SSMClient({ region });
  const { InstanceInformationList } = await ssm.send(
    // @ts-ignore — using raw API call pattern
    new (await import("@aws-sdk/client-ssm")).DescribeInstanceInformationCommand({
      Filters: [
        { Key: "tag:fleetmind:fleet_name", Values: [fleetName] },
        { Key: "tag:fleetmind:agent_id", Values: [agentId] },
      ],
    })
  );
  return InstanceInformationList?.[0]?.InstanceId ?? null;
}

// ── Main logic ────────────────────────────────────────────────────────────────

export interface PullWorkspaceOptions {
  fleet?: string;
  agents?: string[];
  out: string;
  region: string;
  /** S3 bucket for staging the tarball. Defaults to <fleetName>-ledger (the
   * fleet's standard ledger bucket). Override when the operator wants the
   * snapshot to land in a different bucket — e.g. a dedicated debug-snapshot
   * bucket, an audit bucket with longer retention, or a cross-account bucket
   * during a migration. The bot's IAM role must have s3:PutObject on the
   * chosen bucket; the operator's credentials must have s3:GetObject. */
  bucket?: string;
  include: string[];
  diff: boolean;
}

export async function runPullWorkspace(opts: PullWorkspaceOptions): Promise<void> {
  const fleet = loadFleet(opts.fleet ?? "fleet.yaml");
  const fleetName = fleet.fleet.name;
  const bucket = opts.bucket ?? `${fleetName}-ledger`;
  const usingCustomBucket = opts.bucket !== undefined && opts.bucket !== `${fleetName}-ledger`;
  const region = opts.region;
  const outDir = path.resolve(opts.out);
  const include = opts.include.length > 0 ? opts.include : DEFAULT_INCLUDE;

  const targetIds = opts.agents?.length
    ? opts.agents
    : fleet.agents.list.map((a) => a.id);

  const s3 = new S3Client({ region });
  const tmpBase = os.tmpdir();

  if (usingCustomBucket) {
    log.info(`Using custom bucket: s3://${bucket}/ (override of ${fleetName}-ledger)`);
    log.dim(`  → the bot's IAM role must grant s3:PutObject on this bucket; the operator must have s3:GetObject.`);
  }

  for (const agentId of targetIds) {
    log.step(`Pulling workspace for ${agentId}...`);

    // Look up instance
    let instanceId: string | null = null;
    try {
      instanceId = await lookupInstanceId(fleetName, agentId, region);
    } catch (err) {
      log.warn(`  ${agentId}: instance lookup failed — ${String(err)}`);
    }

    if (!instanceId) {
      log.warn(`  ${agentId}: instance not found in SSM — skipping`);
      continue;
    }

    const agent = fleet.getAgent(agentId);
    if (!agent) {
      log.warn(`  ${agentId}: not found in fleet — skipping`);
      continue;
    }
    const target = fleet.targetForAgent(agent);
    const workspaceDir = standardWorkspaceBase(target);
    const tmpTarPath = `/tmp/fleetmind-pull-workspace-${agentId}.tar.gz`;
    const s3Key = `deploy-staging/pull/${agentId}/workspace.tar.gz`;

    // Build the include args for tar
    const includeArgs = include.map((f) => `"${f}"`).join(" ");

    // SSM: tar workspace → upload to S3
    const uploadCmd = [
      `set -euo pipefail`,
      `cd "${workspaceDir}"`,
      `tar czf "${tmpTarPath}" --ignore-failed-read ${includeArgs} 2>/dev/null || true`,
      `aws s3 cp "${tmpTarPath}" "s3://${bucket}/${s3Key}" --region ${region}`,
      `rm -f "${tmpTarPath}"`,
      `echo "ok"`,
    ].join(" && ");

    log.dim(`  → sending SSM command to ${instanceId}...`);
    const result = await sendSsmAndWait(instanceId, [uploadCmd], region, 90_000);

    if (result.status !== "Success") {
      log.warn(`  ${agentId}: SSM command ${result.status} — ${result.stderr.trim() || "no error output"}`);
      continue;
    }

    // Download from S3
    log.dim(`  → downloading from s3://${bucket}/${s3Key}...`);
    const s3Resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
    const body = await s3Resp.Body?.transformToByteArray();
    if (!body) {
      log.warn(`  ${agentId}: empty response from S3`);
      continue;
    }

    // Extract locally
    const localAgentDir = path.join(outDir, agentId);
    fs.mkdirSync(localAgentDir, { recursive: true });
    const localTar = path.join(tmpBase, `pull-workspace-${agentId}.tar.gz`);
    fs.writeFileSync(localTar, body);
    execFileSync("tar", ["xzf", localTar, "-C", localAgentDir], { stdio: "pipe" });
    fs.unlinkSync(localTar);

    // Count files
    const pulledFiles = fs.readdirSync(localAgentDir);
    log.ok(`  ${agentId}: pulled ${pulledFiles.length} items → ${localAgentDir}`);
  }

  log.bold(`\nWorkspace snapshots saved to ${outDir}`);

  if (opts.diff) {
    log.info("\nDiff against rendered baseline:");
    log.dim("  (run `fleetmind render` first to generate a fresh baseline)");
    for (const agentId of targetIds) {
      const pulledDir = path.join(outDir, agentId);
      const renderedDir = path.join(process.cwd(), "rendered", "workspaces", agentId);
      if (!fs.existsSync(pulledDir) || !fs.existsSync(renderedDir)) continue;
      log.info(`\n  ${agentId}:`);
      try {
        const result = execFileSync("diff", ["-rq", "--brief", renderedDir, pulledDir], {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        log.dim(`    ${result.trim() || "no differences"}`);
      } catch (err: unknown) {
        const out = (err as { stdout?: string }).stdout ?? String(err);
        log.info(`    ${out.trim()}`);
      }
    }
  }
}

// ── Commander registration ────────────────────────────────────────────────────

export function registerPullWorkspace(program: Command): void {
  program
    .command("pull-workspace")
    .alias("download-workspace")
    .description("Snapshot each bot's current workspace state to local disk (operator-side)")
    .option("-f, --fleet <path>", "fleet.yaml path")
    .option("-a, --agent <id>", "Pull only this agent (repeatable)",
      (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option("--out <dir>", "Local output directory", "./bot-state")
    .option("--region <region>", "AWS region", "us-west-2")
    .option("--bucket <name>", "S3 bucket for staging the snapshot tarball. Defaults to <fleetName>-ledger.")
    .option("--include <pattern>", "File or directory to include (repeatable; defaults to AGENTS.md SOUL.md MEMORY.md etc.)",
      (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option("--diff", "After pulling, diff each file against the rendered baseline", false)
    .addHelpText('after', `
Default files pulled per agent:
  AGENTS.md  SOUL.md  IDENTITY.md  USER.md  TOOLS.md  HEARTBEAT.md
  MEMORY.md  PATCHES.md  fleet.yaml  memory/  skills/

Use --include to override (repeatable):
  fleetmind pull-workspace --include MEMORY.md --include memory/

Examples:
  # Pull all bots' workspaces to ./bot-state/
  $ fleetmind pull-workspace

  # Same command via the 'download-workspace' alias
  $ fleetmind download-workspace

  # Pull only one agent
  $ fleetmind pull-workspace --agent ariadne

  # Pull and show diff against rendered baseline
  $ fleetmind pull-workspace --diff

  # Pull to a custom directory
  $ fleetmind pull-workspace --out ./snapshots/$(date +%Y%m%d)

  # Stage the snapshot in a custom bucket (e.g. audit or cross-account)
  $ fleetmind pull-workspace --bucket my-audit-bucket --agent ariadne

  # Cross-region pull
  $ fleetmind pull-workspace --region eu-west-1 --bucket eu-west-snapshots
`)
    .action(async (opts: {
      fleet?: string;
      agent: string[];
      out: string;
      region: string;
      bucket?: string;
      include: string[];
      diff: boolean;
    }) => {
      try {
        await runPullWorkspace({
          fleet: opts.fleet,
          agents: opts.agent.length > 0 ? opts.agent : undefined,
          out: opts.out,
          region: opts.region,
          bucket: opts.bucket,
          include: opts.include,
          diff: opts.diff,
        });
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }
    });
}
