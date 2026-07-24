/**
 * fleetmind onboard — interactive guided setup wizard.
 *
 * Walks through every step needed to deploy a new fleet:
 *   1. Validate fleet.yaml
 *   2. Generate Slack app manifests
 *   3. Collect Slack credentials (bot token, signing secret, app token, channels)
 *   4. Discover bot_user_ids
 *   5. Collect GitHub App credentials (app_id, installation_id, pem)
 *   6. Verify FleetMind package access
 *   7. Render tfvars
 *   8. Terraform backend bootstrap + init + validate + plan + apply
 *   9. Populate secrets in Secrets Manager
 *  10. Store GitHub App credentials in SSM
 *  11. Push fleet
 *  12. Verify
 *
 * Each step checks whether it's already done and skips if so —
 * re-running onboard safely picks up where you left off.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { Command } from "commander";
import { loadFleet } from "../../config/loader.js";
import { slackChannel } from "../../core/channels.js";
import { providersForAgent, providerApiKeyVar } from "../../core/model-provider.js";
import { slackSecretName, providerSecretName } from "../../core/secret-names.js";
import { log } from "../../utils/log.js";
import { generateManifests, discoverSlackBotUserIds, writeSlackChannelIds } from "./slack.js";
import { storeGithubApp, createGithubApp } from "./github-app.js";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-secrets-manager";
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  PutBucketTaggingCommand,
} from "@aws-sdk/client-s3";
import {
  DynamoDBClient,
  DescribeTableCommand,
  CreateTableCommand,
  TagResourceCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import {
  STSClient,
  GetCallerIdentityCommand,
} from "@aws-sdk/client-sts";
import {
  SSMClient,
  GetParameterCommand as SsmGetCommand,
  DescribeInstanceInformationCommand,
} from "@aws-sdk/client-ssm";
import { runPushFleet } from "./push-fleet.js";
import { resolveTerraformVarsPath, writeOutputs } from "../../runtime/renderer.js";
import { provisionFleet } from "../../runtime/provisioner.js";

// ── Terminal helpers ──────────────────────────────────────────────────────────

/**
 * Prompt for visible input. Creates a short-lived readline interface so there
 * is never more than one interface reading from stdin at a time.
 */
function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Prompt for hidden input (passwords, tokens).
 *
 * Uses a dedicated readline interface backed by a muted Writable stream so
 * that typed characters are never echoed to the terminal. The interface is
 * closed immediately after the answer is received.
 *
 * This is the canonical Node.js pattern for password prompts — no raw mode,
 * no monkey-patching, no shared-interface conflicts.
 */
function hiddenPrompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    // A Writable that discards everything — prevents readline echoing keystrokes.
    const muted = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    // Print the question ourselves since the muted stream won't show it.
    process.stdout.write(question);

    // terminal: false avoids readline.emitKeypressEvents() which adds a
    // persistent 'data' listener to stdin that is NOT removed on close.
    // With multiple hidden prompts, listeners accumulate and each keystroke
    // fires N times (once per prior hidden prompt). terminal: false uses
    // simple line buffering instead — clean listener lifecycle, no accumulation.
    const rl = createInterface({
      input: process.stdin,
      output: muted,
      terminal: false,
    });

    rl.once("line", (line) => {
      rl.close();
      // Move to next line — the muted stream suppressed the newline the user typed.
      process.stdout.write("\n");
      resolve(line);
    });
  });
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await prompt(`${question} ${hint} `)).trim().toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}

function header(title: string): void {
  const line = "─".repeat(Math.min(process.stdout.columns ?? 60, 60));
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

function step(n: number, total: number, title: string, status: "done" | "next" | "skip"): void {
  const icon = status === "done" ? "✓" : status === "next" ? "→" : "○";
  const color = status === "done" ? "\x1b[32m" : status === "next" ? "\x1b[33m" : "\x1b[2m";
  console.log(`  ${color}${icon}\x1b[0m  ${n}/${total}  ${title}`);
}

function isRealUserId(id: string | undefined): boolean {
  return /^U[A-Z0-9]+$/.test(id ?? "");
}

function isRealChannelId(id: string | undefined): boolean {
  return /^C[A-Z0-9]+$/.test(id ?? "");
}

// ── Dependency-injection types ────────────────────────────────────────────────

/** File-system surface required by the onboard wizard. */
export interface OnboardFsDeps {
  existsSync(path: fs.PathLike): boolean;
  writeFileSync(path: fs.PathOrFileDescriptor, data: string, encoding: BufferEncoding): void;
  readdirSync(path: fs.PathLike): string[];
}

/**
 * All external dependencies required by the onboard wizard.
 *
 * Pass a complete OnboardDeps to `runOnboard` for testing (the helper
 * function fields like pushFleet/provisionFleet/writeOutputs are optional
 * and fall back to the production imports when omitted). Production callers
 * omit the deps argument entirely — the default is `createDefaultDeps(region)`.
 */
export interface OnboardDeps {
  /** Interactive terminal helpers — prompt/hiddenPrompt/confirm. */
  prompter: {
    prompt: (question: string) => Promise<string>;
    hiddenPrompt: (question: string) => Promise<string>;
    confirm: (question: string, defaultYes?: boolean) => Promise<boolean>;
  };
  /** AWS Secrets Manager client instance. */
  secretsManager: SecretsManagerClient;
  /** AWS SSM Parameter Store client instance. */
  ssm: SSMClient;
  /** File-system operations (existsSync / writeFileSync / readdirSync). */
  fs: OnboardFsDeps;
  /** Push fleet to S3 + trigger pull-self on instances. */
  pushFleet?: typeof runPushFleet;
  /** Terraform backend checks/creates + command runner. */
  terraform?: TerraformDeps;
  /** Provision fleet workspaces (render step). */
  provisionFleet?: typeof provisionFleet;
  /** Write rendered tfvars + openclaw.json outputs. */
  writeOutputs?: typeof writeOutputs;
  /** Exit hook for tests; production callers use process.exit. */
  exit?: (code?: string | number | null | undefined) => never;
}

export interface TerraformDeps {
  terraformVersion(): Promise<string>;
  awsIdentity(): Promise<string>;
  bucketExists(bucket: string, region: string): Promise<boolean>;
  configureBucket(bucket: string, region: string, tags: Record<string, string>): Promise<void>;
  createBucket(bucket: string, region: string, tags: Record<string, string>): Promise<void>;
  tableExists(table: string, region: string): Promise<boolean>;
  configureTable(table: string, region: string, tags: Record<string, string>): Promise<void>;
  createTable(table: string, region: string, tags: Record<string, string>): Promise<void>;
  run(args: string[], cwd: string): Promise<void>;
}

/**
 * Build the default production deps for a given region.
 *
 * Called as the default argument to `runOnboard` so tests can pass mocks
 * without touching any CLI plumbing. Production callers never need to call
 * this explicitly — simply omit `deps`.
 */
export function createDefaultDeps(region?: string): OnboardDeps {
  const clientCfg = region ? { region } : {};
  const s3 = new S3Client(clientCfg);
  const dynamodb = new DynamoDBClient(clientCfg);
  const sts = new STSClient(clientCfg);
  return {
    prompter: { prompt, hiddenPrompt, confirm },
    secretsManager: new SecretsManagerClient(clientCfg),
    ssm: new SSMClient(clientCfg),
    fs: {
      existsSync: (p) => fs.existsSync(p),
      writeFileSync: (p, data, enc) => fs.writeFileSync(p, data, enc),
      readdirSync: (p) => fs.readdirSync(p) as string[],
    },
    terraform: createTerraformDeps(s3, dynamodb, sts),
    pushFleet: runPushFleet,
    provisionFleet,
    writeOutputs,
  };
}

// ── AWS helpers ──────────────────────────────────────────────────────────────

async function ssmExistsViaClient(ssmClient: SSMClient, name: string): Promise<boolean> {
  try { await ssmClient.send(new SsmGetCommand({ Name: name })); return true; } catch { return false; }
}

async function getSecretViaClient(smClient: SecretsManagerClient, secretId: string): Promise<string | null> {
  try {
    const r = await smClient.send(new GetSecretValueCommand({ SecretId: secretId }));
    return r.SecretString ?? null;
  } catch { return null; }
}

async function putSecretViaClient(
  smClient: SecretsManagerClient,
  secretId: string,
  value: Record<string, string>,
): Promise<void> {
  try {
    await smClient.send(new PutSecretValueCommand({
      SecretId: secretId,
      SecretString: JSON.stringify(value),
    }));
  } catch (err) {
    // ResourceNotFoundException means Terraform hasn't created the secret yet.
    // Use a name-check so both the real SDK class and the test-mock plain Error work.
    if (
      err instanceof ResourceNotFoundException ||
      (err as { name?: string }).name === "ResourceNotFoundException"
    ) {
      // Terraform creates the secret placeholder during `apply`; if it doesn't
      // exist yet the operator must run Step 8 first.
      throw new Error(
        `Secret '${secretId}' does not exist in Secrets Manager.\n` +
          `This usually means Terraform has not been applied yet (Step 8).\n` +
          `Run \`terraform apply\` to create the secret placeholders, then re-run onboard.`,
      );
    }
    throw err;
  }
}

/** A secret value is "real" if it exists and isn't a render placeholder. */
function secretIsReal(raw: string | null): boolean {
  return !!raw && !raw.includes("REPLACE_ME");
}

/** Does this agent require GitHub access? Every agent does by default; an
 *  agent opts out with `github_access: false` in fleet.yaml. */
function agentNeedsGithubApp(agent: { github_access?: boolean }): boolean {
  return agent.github_access !== false;
}

/** Does any agent require GitHub access? When none do, steps 5/10 are N/A. */
function anyAgentNeedsGithubApp(agents: { github_access?: boolean }[]): boolean {
  return agents.some(agentNeedsGithubApp);
}

/**
 * AWS-only post-onboarding handoff. The aliases are installed by
 * terraform-aws-fleetmind PR #47, so keep that prerequisite explicit rather
 * than presenting a raw user-manager command that operators must copy.
 */
export function formatAwsVerificationHandoff(): string {
  return [
    "  Check that both bots are running:",
    "",
    "  \x1b[36mterraform output ssm_connect\x1b[0m",
    "  (then paste the SSM command for each agent)",
    "",
    "  After pinning terraform-aws-fleetmind PR #47 (or a release containing it):",
    "  \x1b[36msudo -iu openclaw\x1b[0m",
    "  (use targets.<id>.aws.runtime_user when overridden)",
    "  \x1b[36mocalias\x1b[0m   # list shortcuts",
    "  \x1b[36mocstatus\x1b[0m  # gateway status",
    "  \x1b[36moclog\x1b[0m     # recent gateway logs",
    "  \x1b[36moctail\x1b[0m    # follow gateway logs",
    "  \x1b[36mocnatsstatus | ocnatslog | ocnatstail\x1b[0m  # NATS subscriber (when enabled)",
  ].join("\n");
}

function createTerraformDeps(s3: S3Client, dynamodb: DynamoDBClient, sts: STSClient): TerraformDeps {
  const isNotFound = (err: unknown): boolean => {
    const candidate = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    return candidate.name === "NotFound"
      || candidate.name === "NoSuchBucket"
      || candidate.name === "ResourceNotFoundException"
      || candidate.$metadata?.httpStatusCode === 404;
  };

  return {
    async terraformVersion(): Promise<string> {
      const result = spawnSync("terraform", ["version"], {
        encoding: "utf8",
      });
      if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          "Terraform CLI not found. Install Terraform >= 1.6 and ensure `terraform` is on PATH, then re-run `fleetmind onboard`.",
        );
      }
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`terraform version failed with exit code ${result.status}: ${result.stderr}`);
      }
      return (result.stdout.split("\n")[0] ?? "terraform version unknown").trim();
    },
    async awsIdentity(): Promise<string> {
      try {
        const identity = await sts.send(new GetCallerIdentityCommand({}));
        return identity.Arn ?? identity.Account ?? "unknown AWS identity";
      } catch (err) {
        throw new Error(
          `AWS credentials are not usable for Terraform onboarding (${String(err)}).\n` +
          "Configure AWS credentials for the target account/region, then re-run `fleetmind onboard`.",
        );
      }
    },
    async bucketExists(bucket: string): Promise<boolean> {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw new Error(`Unable to check Terraform state bucket ${bucket}: ${String(err)}`);
      }
    },
    async configureBucket(bucket: string, _region: string, tags: Record<string, string>): Promise<void> {
      await s3.send(new PutPublicAccessBlockCommand({
        Bucket: bucket,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      }));
      await s3.send(new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: "Enabled" },
      }));
      await s3.send(new PutBucketEncryptionCommand({
        Bucket: bucket,
        ServerSideEncryptionConfiguration: {
          Rules: [{
            ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
          }],
        },
      }));
      await s3.send(new PutBucketTaggingCommand({
        Bucket: bucket,
        Tagging: {
          TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        },
      }));
    },
    async createBucket(bucket: string, region: string, tags: Record<string, string>): Promise<void> {
      await s3.send(new CreateBucketCommand({
        Bucket: bucket,
        ...(region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: region as never } }),
      }));
      await this.configureBucket(bucket, region, tags);
    },
    async tableExists(table: string): Promise<boolean> {
      try {
        await dynamodb.send(new DescribeTableCommand({ TableName: table }));
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw new Error(`Unable to check Terraform lock table ${table}: ${String(err)}`);
      }
    },
    async configureTable(table: string, _region: string, tags: Record<string, string>): Promise<void> {
      const result = await dynamodb.send(new DescribeTableCommand({ TableName: table }));
      const keySchema = result.Table?.KeySchema ?? [];
      const attributes = result.Table?.AttributeDefinitions ?? [];
      const hasLockIdKey = keySchema.length === 1
        && keySchema[0]?.AttributeName === "LockID"
        && keySchema[0]?.KeyType === "HASH"
        && attributes.some(a => a.AttributeName === "LockID" && a.AttributeType === "S");
      if (!hasLockIdKey) {
        throw new Error(
          `DynamoDB lock table ${table} has an incompatible key schema. ` +
          "Expected a single string hash key named LockID.",
        );
      }
      if (result.Table?.TableArn) {
        await dynamodb.send(new TagResourceCommand({
          ResourceArn: result.Table.TableArn,
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        }));
      }
    },
    async createTable(table: string, region: string, tags: Record<string, string>): Promise<void> {
      await dynamodb.send(new CreateTableCommand({
        TableName: table,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "LockID", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "LockID", KeyType: "HASH" }],
        SSESpecification: { Enabled: true },
      }));
      await waitUntilTableExists(
        { client: dynamodb, maxWaitTime: 120 },
        { TableName: table },
      );
      await this.configureTable(table, region, tags);
    },
    async run(args: string[], cwd: string): Promise<void> {
      const result = spawnSync("terraform", args, {
        cwd,
        stdio: "inherit",
        env: process.env,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`terraform ${args.join(" ")} failed with exit code ${result.status}`);
      }
    },
  };
}

interface TerraformBackendConfig {
  bucket: string;
  region: string;
  key: string;
  dynamodbTable: string;
}

function terraformBackendTags(fleetName: string): Record<string, string> {
  return {
    "fleetmind:fleet_name": fleetName,
    "fleetmind:managed_by": "fleetmind-onboard",
    "terraform:purpose": "remote-state",
  };
}

function readBackendConfig(filePath: string): Partial<TerraformBackendConfig> | null {
  if (!fs.existsSync(filePath)) return null;
  const body = fs.readFileSync(filePath, "utf8");
  const value = (name: string): string | undefined => {
    const match = new RegExp(`^\\s*${name}\\s*=\\s*"([^"]+)"\\s*$`, "m").exec(body);
    return match?.[1];
  };
  return {
    bucket: value("bucket"),
    region: value("region"),
    key: value("key"),
    dynamodbTable: value("dynamodb_table"),
  };
}

function renderBackendConfig(config: TerraformBackendConfig): string {
  return [
    `bucket         = "${config.bucket}"`,
    `region         = "${config.region}"`,
    `key            = "${config.key}"`,
    `dynamodb_table = "${config.dynamodbTable}"`,
    "",
  ].join("\n");
}

function accountIdFromFleetName(fleetName: string): string | undefined {
  return /(\d{12})/.exec(fleetName)?.[1];
}

function defaultBackendConfig(fleetName: string, region: string): TerraformBackendConfig {
  const accountId = accountIdFromFleetName(fleetName);
  const prefix = accountId ? fleetName.replace(new RegExp(`-${accountId}$`), "") : fleetName;
  const suffix = accountId ? `${accountId}-${region}` : region;
  return {
    bucket: `${prefix}-fleetmind-tfstate-${suffix}`.toLowerCase(),
    region,
    // Explicit per-fleet key (not a bare `terraform.tfstate` paired with a CLI
    // workspace) — see fleetmind#255. Keeps each fleet's state independently
    // discoverable in the S3 console/CLI without relying on the operator's
    // currently selected `terraform workspace`.
    key: `fleets/${fleetName}/terraform.tfstate`,
    dynamodbTable: `${prefix}-fleetmind-tf-lock`.toLowerCase(),
  };
}

async function promptBackendConfig(
  fleetName: string,
  region: string,
  backendFile: string,
  deps: OnboardDeps,
): Promise<TerraformBackendConfig> {
  const defaults = defaultBackendConfig(fleetName, region);
  const existing = readBackendConfig(backendFile);
  const current: TerraformBackendConfig = {
    bucket: existing?.bucket ?? defaults.bucket,
    region: existing?.region ?? defaults.region,
    key: existing?.key ?? defaults.key,
    dynamodbTable: existing?.dynamodbTable ?? defaults.dynamodbTable,
  };

  if (existing?.bucket && existing?.region && existing?.key && existing?.dynamodbTable) {
    log.ok(`  backend.hcl found (bucket: ${current.bucket}, table: ${current.dynamodbTable})`);
    return current;
  }

  console.log("  backend.hcl is missing or incomplete. Choose backend settings:");
  const bucket = (await deps.prompter.prompt(`    S3 bucket [${current.bucket}]: `)).trim() || current.bucket;
  const table = (await deps.prompter.prompt(`    DynamoDB lock table [${current.dynamodbTable}]: `)).trim() || current.dynamodbTable;
  const key = (await deps.prompter.prompt(`    Terraform state key [${current.key}]: `)).trim() || current.key;
  const backend = { bucket, region: current.region, key, dynamodbTable: table };

  if (await deps.prompter.confirm(`  Write ${path.basename(backendFile)} with these backend settings?`, true)) {
    deps.fs.writeFileSync(backendFile, renderBackendConfig(backend), "utf8");
    log.ok("  backend.hcl written");
  } else {
    log.warn("  backend.hcl not written; terraform init may fail if backend config is missing.");
  }
  return backend;
}

async function ensureTerraformBackend(
  backend: TerraformBackendConfig,
  fleetName: string,
  deps: OnboardDeps,
): Promise<void> {
  const terraform = deps.terraform ?? createTerraformDeps(
    new S3Client({ region: backend.region }),
    new DynamoDBClient({ region: backend.region }),
    new STSClient({ region: backend.region }),
  );

  const tags = terraformBackendTags(fleetName);
  if (await terraform.bucketExists(backend.bucket, backend.region)) {
    log.ok(`  S3 backend bucket exists: ${backend.bucket}`);
    if (await deps.prompter.confirm("  Configure/verify S3 backend bucket safety settings and tags?", true)) {
      await terraform.configureBucket(backend.bucket, backend.region, tags);
      log.ok("  S3 backend bucket configured");
    } else {
      throw new Error("Cannot continue without verifying/configuring the Terraform state bucket.");
    }
  } else if (await deps.prompter.confirm(`  Create S3 backend bucket ${backend.bucket}?`, true)) {
    await terraform.createBucket(backend.bucket, backend.region, tags);
    log.ok(`  S3 backend bucket created: ${backend.bucket}`);
  } else {
    throw new Error(`Terraform backend bucket does not exist: ${backend.bucket}`);
  }

  if (await terraform.tableExists(backend.dynamodbTable, backend.region)) {
    log.ok(`  DynamoDB lock table exists: ${backend.dynamodbTable}`);
    if (await deps.prompter.confirm("  Configure/verify DynamoDB lock table schema and tags?", true)) {
      await terraform.configureTable(backend.dynamodbTable, backend.region, tags);
      log.ok("  DynamoDB lock table schema/tags verified");
    } else {
      throw new Error("Cannot continue without verifying/configuring the Terraform lock table.");
    }
  } else if (await deps.prompter.confirm(`  Create DynamoDB lock table ${backend.dynamodbTable}?`, true)) {
    await terraform.createTable(backend.dynamodbTable, backend.region, tags);
    log.ok(`  DynamoDB lock table created: ${backend.dynamodbTable}`);
  } else {
    throw new Error(`Terraform lock table does not exist: ${backend.dynamodbTable}`);
  }
}

async function verifyTerraformPrerequisites(terraform: TerraformDeps): Promise<void> {
  const version = await terraform.terraformVersion();
  log.ok(`  Terraform available: ${version}`);
  const identity = await terraform.awsIdentity();
  log.ok(`  AWS credentials active: ${identity}`);
}

function terraformCwdForDerivedTfvars(derivedTfvarsAbs: string): string {
  const derivedDir = path.dirname(derivedTfvarsAbs);
  return path.basename(derivedDir) === "workspaces"
    ? path.dirname(derivedDir)
    : derivedDir;
}

function terraformVarFileArg(terraformCwd: string, fileAbs: string): string {
  const relative = path.relative(terraformCwd, fileAbs);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : fileAbs;
}

function candidateInfraTfvarsPaths(derivedTfvarsAbs: string, fleetName: string): string[] {
  const derivedDir = path.dirname(derivedTfvarsAbs);
  const base = path.basename(derivedTfvarsAbs);
  const paired = base.endsWith(".derived.tfvars")
    ? path.join(derivedDir, base.replace(/\.derived\.tfvars$/, ".tfvars"))
    : path.join(derivedDir, `${fleetName}.tfvars`);
  return [...new Set([
    paired,
    path.join(derivedDir, `${fleetName}.tfvars`),
    path.join(derivedDir, "default.tfvars"),
    path.join(derivedDir, "terraform.tfvars"),
    path.join(derivedDir, "terraform-extras.tfvars"),
  ])];
}

function requireExistingAbsoluteFile(
  candidates: string[],
  description: string,
  deps: OnboardDeps,
): string {
  const match = candidates.find(f => deps.fs.existsSync(f));
  if (match) return match;
  throw new Error(
    `Missing ${description}: expected one of ${candidates.join(", ")}.\n` +
      "Run Step 7 / `fleetmind render` first and ensure the matching infra tfvars file exists.",
  );
}

interface PreflightState {
  /** "done" when GH Apps are all stored, "skip" when no agent needs one, else "next". */
  githubApps: "done" | "next" | "skip";
  terraformApplied: boolean;
  secretsPopulated: boolean;
}

/**
 * Detect real completion of the AWS-touching steps (5/8/9) for the pre-flight
 * summary so re-running onboard doesn't show finished work as outstanding.
 *
 * Every probe is wrapped so any AWS failure (offline, missing creds, throttling)
 * degrades to the not-done value. We never report a false "done".
 */
async function detectRemoteState(args: {
  deps: OnboardDeps;
  fleet: ReturnType<typeof loadFleet>;
  fleetName: string;
  agents: ReturnType<typeof loadFleet>["agents"]["list"];
  region: string;
}): Promise<PreflightState> {
  const { deps, fleet, fleetName, agents } = args;

  // Step 8: Terraform applied — every agent's EC2 instance is registered in SSM
  // under the fleetmind tag namespace. All resolve = apply landed. Uses the
  // injected SSM client (mockable) rather than constructing its own.
  let terraformApplied = false;
  try {
    const hosts = await Promise.all(agents.map(async (a) => {
      const resp = await deps.ssm.send(new DescribeInstanceInformationCommand({
        Filters: [
          { Key: "tag:fleetmind:fleet_name", Values: [fleetName] },
          { Key: "tag:fleetmind:agent_id", Values: [a.id] },
        ],
      }));
      return resp.InstanceInformationList?.[0]?.InstanceId ?? null;
    }));
    terraformApplied = agents.length > 0 && hosts.every(h => !!h);
  } catch { terraformApplied = false; }

  // Step 9: Secrets populated — every agent has a real (non-placeholder) Slack
  // secret AND a real key for each of its declared providers.
  let secretsPopulated = false;
  try {
    const checks = await Promise.all(agents.map(async (agent) => {
      const slackOk = secretIsReal(
        await getSecretViaClient(deps.secretsManager, slackSecretName(fleetName, agent.id)),
      );
      if (!slackOk) return false;
      const providers = providersForAgent({
        agentId: agent.id,
        providers: agent.providers,
        model: agent.model,
        apiKeys: agent.api_keys,
        defaultModel: fleet.agents.defaults.model,
      });
      const provChecks = await Promise.all(providers.map(async (p) =>
        secretIsReal(await getSecretViaClient(
          deps.secretsManager, providerSecretName(fleetName, agent.id, p))),
      ));
      return provChecks.every(Boolean);
    }));
    secretsPopulated = agents.length > 0 && checks.every(Boolean);
  } catch { secretsPopulated = false; }

  // Steps 5/10: GitHub Apps. Skip entirely when no agent declares one. When some
  // do, "done" once every such agent has an app-id parameter in SSM.
  let githubApps: "done" | "next" | "skip";
  if (!anyAgentNeedsGithubApp(agents as { github_access?: boolean }[])) {
    githubApps = "skip";
  } else {
    try {
      const needed = agents.filter(a => agentNeedsGithubApp(a as { github_access?: boolean }));
      const stored = await Promise.all(needed.map(a =>
        ssmExistsViaClient(deps.ssm,
          `/fleetmind/${fleetName}/agents/${a.id}/github-app/app-id`).catch(() => false),
      ));
      githubApps = stored.every(Boolean) ? "done" : "next";
    } catch { githubApps = "next"; }
  }

  return { githubApps, terraformApplied, secretsPopulated };
}

// ── Main wizard ───────────────────────────────────────────────────────────────

export async function runOnboard(
  fleetFile: string,
  region: string,
  opts: { legacyGithubApps?: boolean } = {},
  deps: OnboardDeps = createDefaultDeps(region),
): Promise<void> {
  const exit = deps.exit ?? ((code?: string | number | null | undefined): never => process.exit(code));
  let legacyGithubApps = opts.legacyGithubApps ?? false;
  console.log("\n\x1b[1mfleetmind onboard\x1b[0m — guided fleet setup wizard\n");

  // ── Load fleet ──────────────────────────────────────────────────────────────
  if (!deps.fs.existsSync(fleetFile)) {
    log.error(`fleet.yaml not found at ${fleetFile}. Run from your fleet repo root.`);
    exit(1);
  }

  const fleet = loadFleet(fleetFile);
  const fleetName = fleet.fleet.name;
  const agents = fleet.agents.list;
  const TOTAL = 12;

  // ── Early config validation: providers ─────────────────────────────────────
  // Fail fast before any interactive work if agents are missing the required
  // `providers: [...]` field. This surfaces a clear, actionable error instead
  // of propagating a late throw inside the preflight AWS checks.
  for (const agent of agents) {
    try {
      providersForAgent({
        agentId: agent.id,
        providers: agent.providers,
        model: agent.model,
        apiKeys: agent.api_keys,
        defaultModel: fleet.agents.defaults.model,
      });
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      exit(1);
    }
  }

  console.log(`  Fleet: \x1b[1m${fleetName}\x1b[0m  (${agents.length} agent${agents.length !== 1 ? "s" : ""}: ${agents.map(a => a.name).join(", ")})`);

  // ── Pre-flight status ───────────────────────────────────────────────────────
  const manifestsDir = path.join(path.dirname(fleetFile), "docs", "slack-manifests");
  const manifestsExist = deps.fs.existsSync(manifestsDir) &&
    deps.fs.readdirSync(manifestsDir).some(f => f.endsWith(".yaml"));

  const allUserIdsSet = agents.every(a => isRealUserId(slackChannel(a)?.bot_user_id));
  const allChannelsSet = agents.every(a => (slackChannel(a)?.channels ?? []).every(c => isRealChannelId(c)));

  // Render output: the renderer writes the derived tfvars next to the
  // `workspaces/` infra tfvars directory (a plain directory name, unrelated
  // to `terraform workspace` — see fleetmind#255). Accept either
  // `workspaces/<fleet>.derived.tfvars` or `workspaces/default.derived.tfvars`
  // so Step 7 isn't a false negative.
  const derivedTfvarsCandidates = [
    `workspaces/${fleetName}.derived.tfvars`,
    "workspaces/default.derived.tfvars",
  ];
  const tfvarsExist = derivedTfvarsCandidates.some(f =>
    deps.fs.existsSync(path.join(path.dirname(fleetFile), f)));

  // Steps 5/8/9 touch AWS (SSM + Secrets Manager). Detect real completion so
  // re-runs don't show already-finished steps as outstanding. Any AWS error
  // (offline, no creds) falls back to "next" — never a false "done".
  const preflight = await detectRemoteState({
    deps, fleet, fleetName, agents, region,
  });

  console.log();
  step(1, TOTAL, "fleet.yaml configured", "done");
  step(2, TOTAL, "Slack app manifests", manifestsExist ? "done" : "next");
  step(3, TOTAL, "Slack credentials", allUserIdsSet && allChannelsSet ? "done" : "next");
  step(4, TOTAL, "bot_user_ids", allUserIdsSet ? "done" : "next");
  step(5, TOTAL, "GitHub Apps", preflight.githubApps);
  step(6, TOTAL, "FleetMind package access", "done");
  step(7, TOTAL, "Render tfvars", tfvarsExist ? "done" : "next");
  step(8, TOTAL, "Terraform", preflight.terraformApplied ? "done" : "next");
  step(9, TOTAL, "Populate secrets", preflight.secretsPopulated ? "done" : "next");
  step(10, TOTAL, "Store GitHub App credentials", preflight.githubApps);
  step(11, TOTAL, "Push fleet", "next");
  step(12, TOTAL, "Verify", "next");
  console.log();

  if (!await deps.prompter.confirm("Start onboarding?")) {
    console.log("Aborted.");
    return;
  }

  // In-memory credential store (collected during the wizard, used later)
  const slackCreds: Record<string, { botToken: string; signingSecret: string; appToken: string }> = {};
  const ghAppCreds: Record<string, { appId: string; installationId: string; pemFile: string }> = {};
  /** Agent IDs whose GitHub App was created via the manifest flow in Step 5.
   * These already have credentials in SSM; Step 10 doesn't need to re-store. */
  const ghAppManifestHandled = new Set<string>();

  // ── Step 2: Slack manifests ─────────────────────────────────────────────────
  if (!manifestsExist) {
    header("Step 2 / 12 — Generate Slack App Manifests");
    console.log("  Generates a YAML manifest for each agent that you paste into api.slack.com.");
    if (await deps.prompter.confirm("  Generate manifests now?")) {
      await generateManifests({
        fleet: fleetFile,
        out: manifestsDir,
        agent: [],
      });
      log.ok(`  Manifests written to ${manifestsDir}`);
    }
  } else {
    log.ok("Step 2: manifests already generated — skipping");
  }

  // ── Step 3: Collect Slack credentials ──────────────────────────────────────
  const needsCreds = agents.some(a => !isRealUserId(slackChannel(a)?.bot_user_id));
  if (needsCreds) {
    header("Step 3 / 12 — Create Slack Apps + Collect Credentials");
    console.log("  For each agent, create a Slack app from its manifest:");
    console.log(`  → Open ${manifestsDir}`);
    console.log("  → Go to https://api.slack.com/apps → Create New App → From a manifest");
    console.log("  → Paste the YAML, install to workspace, capture credentials\n");

    for (const agent of agents) {
      console.log(`\x1b[1m  Agent: ${agent.emoji} ${agent.name} (${agent.id})\x1b[0m`);
      const botToken = await deps.prompter.hiddenPrompt(`    Bot Token (xoxb-...): `);
      const signingSecret = await deps.prompter.hiddenPrompt(`    Signing Secret:       `);
      const appToken = await deps.prompter.hiddenPrompt(`    App Token (xapp-...): `);
      slackCreds[agent.id] = { botToken, signingSecret, appToken };
      console.log();
    }

    // Channel IDs
    console.log("  Now invite each bot to its Slack channels and copy the channel IDs.\n");
    const channelUpdates = new Map<string, string[]>();

    for (const agent of agents) {
      const existing = (slackChannel(agent)?.channels ?? []).filter(c => isRealChannelId(c));
      if (existing.length > 0) {
        log.ok(`    ${agent.name}: channels already set (${existing.join(", ")})`);
        continue;
      }
      console.log(`\x1b[1m  ${agent.emoji} ${agent.name} — channel IDs\x1b[0m`);
      console.log("    (comma-separated, format: C0123456789)");
      const channelInput = await deps.prompter.prompt("    Channel IDs: ");
      const channelIds = channelInput.split(",").map(c => c.trim()).filter(Boolean);
      if (channelIds.length > 0) {
        channelUpdates.set(agent.id, channelIds);
      }
    }

    if (channelUpdates.size > 0) {
      // Write channel IDs into each agent's slack channel entry via the yaml
      // document API (preserves comments; targets the v2 nested channels list).
      writeSlackChannelIds(fleetFile, channelUpdates, (p, content) => deps.fs.writeFileSync(p, content, "utf-8"));
      log.ok("  fleet.yaml updated with channel IDs");
    }
  } else {
    log.ok("Step 3: Slack apps already configured — skipping credential collection");
    log.dim("  Step 9 will check Secrets Manager and offer override if needed.");
  }

  // ── Step 4: Discover bot_user_ids ───────────────────────────────────────────
  if (!allUserIdsSet) {
    header("Step 4 / 12 — Discover bot_user_ids");
    console.log("  Calls Slack auth.test using the tokens entered in step 3.");
    if (await deps.prompter.confirm("  Run fleetmind slack discover?")) {
      // Pass tokens via env vars — the discover command resolves
      // <AGENT_UPPER>_BOT_TOKEN before falling back to Secrets Manager.
      const toClean: string[] = [];
      for (const [agentId, creds] of Object.entries(slackCreds)) {
        const key = `${agentId.toUpperCase().replace(/-/g, "_")}_BOT_TOKEN`;
        process.env[key] = creds.botToken;
        toClean.push(key);
      }
      try {
        await discoverSlackBotUserIds({ fleet: fleetFile, region, interactive: false, dryRun: false, force: false });
        log.ok("  bot_user_ids written to fleet.yaml");
      } finally {
        // Clean up env vars — don't leave tokens in process.env
        for (const key of toClean) delete process.env[key];
      }
    }
  } else {
    log.ok("Step 4: all bot_user_ids already set — skipping");
  }

  // ── Step 5: GitHub Apps ─────────────────────────────────────────────────────
  // Every agent requires its own GitHub App by default. An agent opts out by
  // setting `github_access: false` in fleet.yaml. When EVERY agent has opted
  // out, skip the whole step (no owner prompt, no per-agent prompts) so fleets
  // that genuinely don't touch GitHub aren't dragged through it.
  const githubAppNeeded = anyAgentNeedsGithubApp(agents as { github_access?: boolean }[]);
  if (!githubAppNeeded) {
    header("Step 5 / 12 — GitHub Apps");
    log.ok("  Every agent has github_access: false in fleet.yaml — skipping.");
    log.dim("  Remove github_access: false from an agent (and re-run) if a bot needs repo access.");
  } else {
  header("Step 5 / 12 — GitHub Apps");
  console.log("  Each bot needs its own GitHub App for repo access (PRs, issues, etc.)");
  if (legacyGithubApps) {
    console.log("  Legacy mode: you'll be prompted for App ID + Installation ID + PEM path per agent.");
    console.log("  → Create each App manually at https://github.com/organizations/YOUR-ORG/settings/apps/new\n");
  } else {
    console.log("  Using the manifest flow: fleetmind opens a one-click URL per agent;");
    console.log("  you click 'Create App' + 'Install' in your browser. The PEM never lands on this laptop —");
    console.log("  it's fetched from the GitHub API and written directly to SSM.\n");
  }

  // For the manifest flow we need a GitHub owner. Ask once — same owner for
  // all agents in this fleet (per the canonical client-org delivery model).
  let ghOwner: string | null = null;
  let ghOrgOwned = true;
  if (!legacyGithubApps) {
    const ownerInput = await deps.prompter.prompt(`  GitHub owner for all bots (org name, or 'username:<user>' for user-owned): `);
    const trimmed = ownerInput.trim();
    if (trimmed.startsWith("username:")) {
      ghOwner = trimmed.slice("username:".length).trim();
      ghOrgOwned = false;
    } else {
      ghOwner = trimmed;
      ghOrgOwned = true;
    }
    if (!ghOwner) {
      log.warn("  No owner provided — falling back to legacy manual flow for this step.");
      legacyGithubApps = true;
    }
  }

  for (const agent of agents) {
    // Honor per-agent opt-out: agents with github_access: false never get an App.
    if (!agentNeedsGithubApp(agent as { github_access?: boolean })) {
      log.dim(`  ${agent.emoji} ${agent.name}: github_access: false — skipping.`);
      continue;
    }
    const ssmKey = `/fleetmind/${fleetName}/agents/${agent.id}/github-app/app-id`;
    const alreadyInSsm = await ssmExistsViaClient(deps.ssm, ssmKey);

    if (alreadyInSsm) {
      const override = await deps.prompter.confirm(`  ${agent.emoji} ${agent.name}: GitHub App already populated in SSM. Override?`, false);
      if (!override) {
        log.ok(`  ${agent.name}: using existing GitHub App credentials`);
        continue;
      }
    } else {
      console.log(`\n\x1b[1m  ${agent.emoji} ${agent.name} (${agent.id})\x1b[0m`);
    }

    if (legacyGithubApps) {
      const appId = await deps.prompter.prompt(`    App ID:          `);
      const installationId = await deps.prompter.prompt(`    Installation ID: `);
      const pemFile = await deps.prompter.prompt(`    PEM file path:   `);
      ghAppCreds[agent.id] = { appId: appId.trim(), installationId: installationId.trim(), pemFile: pemFile.trim() };
      continue;
    }

    // Manifest flow path — createGithubApp writes to SSM directly.
    const doIt = await deps.prompter.confirm(`    Set up GitHub App for ${agent.id} now?`, true);
    if (!doIt) {
      log.warn(`    ${agent.id}: skipped — run 'fleetmind github-app create' later for this bot`);
      continue;
    }
    try {
      await createGithubApp({
        fleet: fleetName,
        agent: agent.id,
        role: agent.role,
        githubAppConfig: agent.github_app,
        owner: ghOwner!,
        org: ghOrgOwned,
        callbackPort: 0,
        region,
        dryRun: false,
        overwrite: true,
        ssmClient: deps.ssm,
      });
      // Mark as manifest-handled so Step 10 knows there's nothing left to do.
      ghAppManifestHandled.add(agent.id);
    } catch (err) {
      log.error(`    ${agent.id}: createGithubApp failed — ${String(err)}`);
      log.warn(`    Falling back to manual prompts for this agent.`);
      const appId = await deps.prompter.prompt(`    App ID:          `);
      const installationId = await deps.prompter.prompt(`    Installation ID: `);
      const pemFile = await deps.prompter.prompt(`    PEM file path:   `);
      ghAppCreds[agent.id] = { appId: appId.trim(), installationId: installationId.trim(), pemFile: pemFile.trim() };
    }
  }
  console.log();
  } // end GitHub Apps (step 5) when githubAppNeeded

  // ── Step 6: FleetMind package access ────────────────────────────────────────
  header("Step 6 / 12 — FleetMind package access");
  console.log("  Bots install the fleetmind CLI from public npm at bootstrap.");
  log.ok("  No GitHub Packages PAT or registry-specific .npmrc is required.");

  // ── Step 7: Render ──────────────────────────────────────────────────────────
  header("Step 7 / 12 — Render");
  console.log("  Generates per-agent openclaw.json and workspaces/derived.tfvars from fleet.yaml.");
  if (await deps.prompter.confirm("  Run fleetmind render?")) {
    const reloadedFleet = loadFleet(fleetFile);
    const provisionFn = deps.provisionFleet ?? provisionFleet;
    const writeFn = deps.writeOutputs ?? writeOutputs;
    await provisionFn(reloadedFleet, false, path.dirname(fleetFile));
    writeFn(reloadedFleet, path.dirname(fleetFile));
    log.ok("  Rendered successfully");
  }

  // ── Step 8: Terraform ───────────────────────────────────────────────────────
  header("Step 8 / 12 — Terraform");
  const fleetDir = path.dirname(fleetFile);
  const terraform = deps.terraform ?? createTerraformDeps(
    new S3Client({ region }),
    new DynamoDBClient({ region }),
    new STSClient({ region }),
  );
  const derivedTfvarsAbs = resolveTerraformVarsPath(fleet, fleetDir);
  const terraformCwd = terraformCwdForDerivedTfvars(derivedTfvarsAbs);
  const backendFile = path.join(terraformCwd, "backend.hcl");
  const planFile = `.fleetmind-${fleetName}.tfplan`;

  console.log("  This can create the remote state backend and run Terraform from the detected Terraform directory.");
  console.log(`  cwd: ${terraformCwd}`);
  console.log(`  derived tfvars: ${terraformVarFileArg(terraformCwd, derivedTfvarsAbs)}`);
  if (await deps.prompter.confirm("  Run Terraform backend/bootstrap + init/validate/plan/apply now?", false)) {
    const derivedTfvarsPath = requireExistingAbsoluteFile(
      [derivedTfvarsAbs],
      "derived Terraform variable file",
      deps,
    );
    const infraTfvarsPath = requireExistingAbsoluteFile(
      candidateInfraTfvarsPaths(derivedTfvarsAbs, fleetName),
      "Terraform variable file",
      deps,
    );
    const infraTfvarsArg = terraformVarFileArg(terraformCwd, infraTfvarsPath);
    const derivedTfvarsArg = terraformVarFileArg(terraformCwd, derivedTfvarsPath);
    await verifyTerraformPrerequisites(terraform);
    const backend = await promptBackendConfig(fleetName, region, backendFile, deps);
    await ensureTerraformBackend(backend, fleetName, deps);

    log.info("  terraform init");
    await terraform.run(["init", "-backend-config=backend.hcl"], terraformCwd);

    log.info("  terraform validate");
    await terraform.run(["validate"], terraformCwd);

    log.info("  terraform plan");
    await terraform.run([
      "plan",
      `-var-file=${infraTfvarsArg}`,
      `-var-file=${derivedTfvarsArg}`,
      `-out=${planFile}`,
    ], terraformCwd);

    if (await deps.prompter.confirm("  Apply this Terraform plan now?", false)) {
      log.info("  terraform apply");
      await terraform.run(["apply", planFile], terraformCwd);
      log.ok("  Terraform apply complete");
    } else {
      log.warn(`  Terraform apply skipped. Plan saved at ${planFile}`);
      console.log(`  Run later from ${terraformCwd}: \x1b[36mterraform apply ${planFile}\x1b[0m`);
    }
  } else {
    console.log("  Terraform skipped. Run this step later before populating Secrets Manager:");
    console.log(`  \x1b[36mfleetmind onboard --fleet ${fleetFile} --region ${region}\x1b[0m`);
  }

  // ── Step 9: Populate Secrets Manager ────────────────────────────────────────
  header("Step 9 / 12 — Populate Secrets Manager");
  console.log("  Writes Slack tokens + model-provider API keys per agent.");
  console.log("  Slack tokens from step 3 are used automatically; provider keys are prompted.\n");

  if (await deps.prompter.confirm("  Populate secrets now?")) {
    for (const agent of agents) {
      console.log(`\n\x1b[1m  ${agent.emoji} ${agent.name} (${agent.id})\x1b[0m`);
      const slackSecretId = slackSecretName(fleetName, agent.id);

      // ── Slack tokens ────────────────────────────────────────────────────────
      const collected = slackCreds[agent.id];
      const existingSlack = await getSecretViaClient(deps.secretsManager, slackSecretId);
      const slackIsPlaceholder = !existingSlack || existingSlack.includes("REPLACE_ME");

      let writeSlack = false;
      let slackPayload: Record<string, string> | null = null;

      if (collected) {
        if (!slackIsPlaceholder) {
          // Already has real values — ask before overwriting (default: keep)
          writeSlack = await deps.prompter.confirm("    Slack tokens already populated. Override with step-3 values?", false);
        } else {
          writeSlack = true;
        }
        if (writeSlack) {
          slackPayload = {
            SLACK_BOT_TOKEN: collected.botToken,
            SLACK_SIGNING_SECRET: collected.signingSecret,
            SLACK_APP_TOKEN: collected.appToken,
          };
        }
      } else {
        // No tokens from step 3 — prompt now
        if (!slackIsPlaceholder && !await deps.prompter.confirm("    Slack tokens already populated. Override?", false)) {
          log.ok("    Slack tokens unchanged");
        } else {
          const botToken = await deps.prompter.hiddenPrompt("    Bot Token (xoxb-...):      ");
          const signingSecret = await deps.prompter.hiddenPrompt("    Signing Secret:           ");
          const appToken = await deps.prompter.hiddenPrompt("    App Token (xapp-...):     ");
          slackPayload = { SLACK_BOT_TOKEN: botToken, SLACK_SIGNING_SECRET: signingSecret, SLACK_APP_TOKEN: appToken };
          writeSlack = true;
        }
      }

      if (writeSlack && slackPayload) {
        await putSecretViaClient(deps.secretsManager, slackSecretId, slackPayload);
        log.ok("    Slack tokens written");
      }

      // ── Model-provider API keys — one secret per (agent, provider). ────────────
      const providers = providersForAgent({
        agentId: agent.id,
        providers: agent.providers,
        model: agent.model,
        apiKeys: agent.api_keys,
        defaultModel: fleet.agents.defaults.model,
      });
      for (const provider of providers) {
        const secretId = providerSecretName(fleetName, agent.id, provider);
        const keyVar = providerApiKeyVar(provider);
        const existingRaw = await getSecretViaClient(deps.secretsManager, secretId);
        const isPlaceholder = !existingRaw || existingRaw.includes("REPLACE_ME");
        let writeKey = isPlaceholder;
        if (!isPlaceholder) {
          writeKey = await deps.prompter.confirm(`    ${provider} API key already populated. Override?`, false);
        }
        if (writeKey) {
          const apiKey = await deps.prompter.hiddenPrompt(`    ${provider} API key (${keyVar}): `);
          if (apiKey.trim()) {
            await putSecretViaClient(deps.secretsManager, secretId, { [keyVar]: apiKey.trim() });
            log.ok(`    ${provider} key written (${keyVar})`);
          } else {
            log.warn(`    ${provider} key skipped (empty)`);
          }
        } else {
          log.ok(`    ${provider} key unchanged`);
        }
      }
    }
  }

  // ── Step 10: GitHub App credentials ─────────────────────────────────────────
  header("Step 10 / 12 — Store GitHub App Credentials in SSM");
  if (ghAppManifestHandled.size > 0) {
    log.ok(`Step 10: ${ghAppManifestHandled.size} agent${ghAppManifestHandled.size === 1 ? "" : "s"} already stored via manifest flow in Step 5`);
  }
  const agentsWithNewCreds = Object.keys(ghAppCreds);
  if (agentsWithNewCreds.length === 0) {
    if (ghAppManifestHandled.size === 0) {
      log.ok("Step 10: no new GitHub App credentials to store — skipping");
    }
  } else if (await deps.prompter.confirm(`  Store ${agentsWithNewCreds.length} legacy-flow GitHub App credential set${agentsWithNewCreds.length === 1 ? "" : "s"}?`)) {
    for (const [agentId, creds] of Object.entries(ghAppCreds)) {
      if (!creds.appId || !creds.installationId || !creds.pemFile) {
        log.warn(`  ${agentId}: incomplete credentials — skipping`);
        continue;
      }
      if (!deps.fs.existsSync(creds.pemFile)) {
        log.warn(`  ${agentId}: pem file not found at ${creds.pemFile} — skipping`);
        continue;
      }
      await storeGithubApp({
        fleet: fleetName, agent: agentId,
        appId: creds.appId, installationId: creds.installationId, pemFile: creds.pemFile,
        region, dryRun: false, overwrite: true, ssmClient: deps.ssm,
      });
      log.ok(`  ${agentId}: GitHub App credentials stored`);
    }
  }

  // ── Step 11: Push fleet ──────────────────────────────────────────────────────
  header("Step 11 / 12 — Push Fleet");
  console.log("  Packages workspace + skills → uploads to S3 → triggers pull-self on each EC2.");
  console.log("  Also upgrades the fleetmind CLI on each instance to the current version.\n");
  if (await deps.prompter.confirm("  Run fleetmind push fleet --restart --upgrade-cli?")) {
    const pushFn = deps.pushFleet ?? runPushFleet;
    await pushFn({
      fleet: fleetFile,
      region,
      restart: true,
      upgradeCli: "latest",
      dryRun: false,
      noApply: false,
    });
  }

  // ── Step 12: Verify ──────────────────────────────────────────────────────────
  header("Step 12 / 12 — Verify");
  console.log(`${formatAwsVerificationHandoff()}\n`);

  console.log("\x1b[32m\x1b[1m🎉 Onboarding complete!\x1b[0m");
  console.log(`  Fleet \x1b[1m${fleetName}\x1b[0m is deployed. Your bots should be online in Slack shortly.\n`);
}

// ── Commander registration ────────────────────────────────────────────────────

export function registerOnboard(program: Command): void {
  program
    .command("onboard")
    .description("Interactive guided wizard to deploy a new fleet from start to finish")
    .option("-f, --fleet <path>", "fleet.yaml path", "./fleet.yaml")
    .option("--region <region>", "AWS region", "us-west-2")
    .option("--legacy-github-apps", "Use the manual GitHub App flow (prompts for App ID + Installation ID + PEM path) instead of the manifest flow. Use this in headless/CI contexts where a browser callback isn't possible.", false)
    .addHelpText('after', `
Steps guided by this wizard:
  1.  Validate fleet.yaml
  2.  Generate Slack app manifests
  3.  Collect Slack credentials (tokens, channel IDs)
  4.  Discover bot_user_ids via Slack auth.test
  5.  Collect GitHub App credentials (app_id, installation_id, pem)
  6.  Verify FleetMind package access
  7.  Run fleetmind render
  8.  Bootstrap Terraform backend, then init + validate + plan + apply
  9.  Populate Secrets Manager (Slack + Anthropic keys)
  10. Store GitHub App credentials in SSM
  11. Run fleetmind push fleet --restart --upgrade-cli
  12. Verify — print terraform output commands

Re-running onboard is safe — completed steps are skipped automatically.
`)
    .action(async (opts: { fleet: string; region: string; legacyGithubApps: boolean }) => {
      try {
        await runOnboard(opts.fleet, opts.region, { legacyGithubApps: opts.legacyGithubApps });
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }
    });
}
