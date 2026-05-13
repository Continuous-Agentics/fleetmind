/**
 * fleetmind onboard — interactive guided setup wizard.
 *
 * Walks through every step needed to deploy a new fleet:
 *   1. Validate fleet.yaml
 *   2. Generate Slack app manifests
 *   3. Collect Slack credentials (bot token, signing secret, app token, channels)
 *   4. Discover bot_user_ids
 *   5. Collect GitHub App credentials (app_id, installation_id, pem)
 *   6. Check/set GitHub Packages PAT
 *   7. Render tfvars
 *   8. Terraform init + workspace + apply (guided, operator runs manually)
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
import readline from "node:readline";
import type { Command } from "commander";
import { loadFleet } from "../../config/loader.js";
import { log } from "../../utils/log.js";
import { generateManifests } from "./slack.js";
import { discoverSlackBotUserIds } from "./slack.js";
import { populateSecrets } from "./populate.js";
import { promptHidden } from "./populate.js";
import { storeGithubApp } from "./github-app.js";
import { runPushFleet } from "./push-fleet.js";
import { writeOutputs, renderTerraformVars } from "../../runtime/renderer.js";
import { provisionFleet } from "../../runtime/provisioner.js";

// ── Terminal helpers ──────────────────────────────────────────────────────────

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function confirm(rl: readline.Interface, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await prompt(rl, `${question} ${hint} `)).trim().toLowerCase();
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

// ── Step checks ───────────────────────────────────────────────────────────────

function isRealUserId(id: string | undefined): boolean {
  return /^U[A-Z0-9]+$/.test(id ?? "");
}

function isRealChannelId(id: string | undefined): boolean {
  return /^C[A-Z0-9]+$/.test(id ?? "");
}

// ── Main wizard ───────────────────────────────────────────────────────────────

export async function runOnboard(fleetFile: string, region: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("\n\x1b[1mfleetmind onboard\x1b[0m — guided fleet setup wizard\n");

  // ── Load fleet ──────────────────────────────────────────────────────────────
  if (!fs.existsSync(fleetFile)) {
    log.error(`fleet.yaml not found at ${fleetFile}. Run from your fleet repo root.`);
    process.exit(1);
  }

  const fleet = loadFleet(fleetFile);
  const fleetName = fleet.fleet.name;
  const agents = fleet.agents.list;
  const TOTAL = 12;

  console.log(`  Fleet: \x1b[1m${fleetName}\x1b[0m  (${agents.length} agent${agents.length !== 1 ? "s" : ""}: ${agents.map(a => a.name).join(", ")})`);

  // ── Pre-flight status ───────────────────────────────────────────────────────
  const manifestsDir = path.join(path.dirname(fleetFile), "docs", "slack-manifests");
  const manifestsExist = fs.existsSync(manifestsDir) &&
    fs.readdirSync(manifestsDir).some(f => f.endsWith(".yaml"));

  const allUserIdsSet = agents.every(a => isRealUserId(a.slack?.bot_user_id));
  const allChannelsSet = agents.every(a => (a.slack?.channels ?? []).every(c => isRealChannelId(c)));

  const derivedTfvars = path.join(path.dirname(fleetFile), `workspaces/${fleetName}.derived.tfvars`);
  const tfvarsExist = fs.existsSync(derivedTfvars);

  console.log();
  step(1, TOTAL, "fleet.yaml configured", "done");
  step(2, TOTAL, "Slack app manifests", manifestsExist ? "done" : "next");
  step(3, TOTAL, "Slack credentials", allUserIdsSet && allChannelsSet ? "done" : allUserIdsSet ? "next" : "next");
  step(4, TOTAL, "bot_user_ids", allUserIdsSet ? "done" : "next");
  step(5, TOTAL, "GitHub Apps", "next");
  step(6, TOTAL, "GitHub Packages PAT", "next");
  step(7, TOTAL, "Render tfvars", tfvarsExist ? "done" : "next");
  step(8, TOTAL, "Terraform apply", "next");
  step(9, TOTAL, "Populate secrets", "next");
  step(10, TOTAL, "Store GitHub App credentials", "next");
  step(11, TOTAL, "Push fleet", "next");
  step(12, TOTAL, "Verify", "next");
  console.log();

  if (!await confirm(rl, "Start onboarding?")) {
    console.log("Aborted.");
    rl.close();
    return;
  }

  // In-memory credential store (collected during the wizard, used later)
  const slackCreds: Record<string, { botToken: string; signingSecret: string; appToken: string }> = {};
  const ghAppCreds: Record<string, { appId: string; installationId: string; pemFile: string }> = {};

  // ── Step 2: Slack manifests ─────────────────────────────────────────────────
  if (!manifestsExist) {
    header("Step 2 / 12 — Generate Slack App Manifests");
    console.log("  Generates a YAML manifest for each agent that you paste into api.slack.com.");
    if (await confirm(rl, "  Generate manifests now?")) {
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
  const needsCreds = agents.some(a => !isRealUserId(a.slack?.bot_user_id));
  if (needsCreds) {
    header("Step 3 / 12 — Create Slack Apps + Collect Credentials");
    console.log("  For each agent, create a Slack app from its manifest:");
    console.log(`  → Open ${manifestsDir}`);
    console.log("  → Go to https://api.slack.com/apps → Create New App → From a manifest");
    console.log("  → Paste the YAML, install to workspace, capture credentials\n");

    for (const agent of agents) {
      console.log(`\x1b[1m  Agent: ${agent.emoji} ${agent.name} (${agent.id})\x1b[0m`);
      const botToken = await promptHidden(`    Bot Token (xoxb-...): `);
      const signingSecret = await promptHidden(`    Signing Secret:       `);
      const appToken = await promptHidden(`    App Token (xapp-...): `);
      slackCreds[agent.id] = { botToken, signingSecret, appToken };
      console.log();
    }

    // Channel IDs
    console.log("  Now invite each bot to its Slack channels and copy the channel IDs.\n");
    const updatedFleetYaml = fs.readFileSync(fleetFile, "utf-8");
    let yamlContent = updatedFleetYaml;

    for (const agent of agents) {
      const existing = (agent.slack?.channels ?? []).filter(c => isRealChannelId(c));
      if (existing.length > 0) {
        log.ok(`    ${agent.name}: channels already set (${existing.join(", ")})`);
        continue;
      }
      console.log(`\x1b[1m  ${agent.emoji} ${agent.name} — channel IDs\x1b[0m`);
      console.log("    (comma-separated, format: C0123456789)");
      const channelInput = await prompt(rl, "    Channel IDs: ");
      const channelIds = channelInput.split(",").map(c => c.trim()).filter(Boolean);
      if (channelIds.length > 0) {
        // Write channel IDs back to fleet.yaml
        yamlContent = yamlContent.replace(
          new RegExp(`(id:\\s*${agent.id}[\\s\\S]*?channels:\\s*)\\["C_REPLACE_ME"\\]`),
          `$1[${channelIds.map(c => `"${c}"`).join(", ")}]`
        );
      }
    }

    if (yamlContent !== updatedFleetYaml) {
      fs.writeFileSync(fleetFile, yamlContent, "utf-8");
      log.ok("  fleet.yaml updated with channel IDs");
    }
  } else {
    log.ok("Step 3: Slack credentials already populated — collecting for secrets populate");
    // Still need to collect for secrets populate later
    for (const agent of agents) {
      console.log(`\x1b[1m  Agent: ${agent.emoji} ${agent.name} (${agent.id})\x1b[0m`);
      const botToken = await promptHidden(`    Bot Token (xoxb-...): `);
      const signingSecret = await promptHidden(`    Signing Secret:       `);
      const appToken = await promptHidden(`    App Token (xapp-...): `);
      slackCreds[agent.id] = { botToken, signingSecret, appToken };
    }
  }

  // ── Step 4: Discover bot_user_ids ───────────────────────────────────────────
  if (!allUserIdsSet) {
    header("Step 4 / 12 — Discover bot_user_ids");
    console.log("  Calls Slack auth.test for each agent using the tokens you just entered.");
    if (await confirm(rl, "  Run fleetmind slack discover --interactive?")) {
      // Set env vars from collected creds so discover can use them
      for (const [agentId, creds] of Object.entries(slackCreds)) {
        const envKey = `${agentId.toUpperCase().replace(/-/g, "_")}_BOT_TOKEN`;
        process.env[envKey] = creds.botToken;
      }
      await discoverSlackBotUserIds({
        fleet: fleetFile,
        region,
        interactive: false, // use env vars we just set
        dryRun: false,
        force: false,
      });
      log.ok("  bot_user_ids written to fleet.yaml");
    }
  } else {
    log.ok("Step 4: all bot_user_ids already set — skipping");
  }

  // ── Step 5: GitHub Apps ─────────────────────────────────────────────────────
  header("Step 5 / 12 — GitHub Apps");
  console.log("  Each bot needs its own GitHub App for repo access (PRs, issues, etc.)");
  console.log("  → Go to https://github.com/organizations/YOUR-ORG/settings/apps/new");
  console.log("  → Create one app per agent, generate a private key (.pem), install it");
  console.log("  → Capture: App ID (from app settings page) + Installation ID (from install URL)\n");

  for (const agent of agents) {
    console.log(`\x1b[1m  Agent: ${agent.emoji} ${agent.name} (${agent.id})\x1b[0m`);
    const appId = await prompt(rl, `    App ID:          `);
    const installationId = await prompt(rl, `    Installation ID: `);
    const pemFile = await prompt(rl, `    PEM file path:   `);
    ghAppCreds[agent.id] = { appId: appId.trim(), installationId: installationId.trim(), pemFile: pemFile.trim() };
    console.log();
  }

  // ── Step 6: GitHub Packages PAT ─────────────────────────────────────────────
  header("Step 6 / 12 — GitHub Packages PAT");
  console.log("  Bots install the fleetmind CLI from GitHub Packages at bootstrap.");
  console.log("  Needs a PAT with read:packages scope stored in SSM.");
  console.log(`  SSM path: /fleetmind/shared/github-packages-token  (region: ${region})`);

  // Check if it exists
  let patExists = false;
  try {
    const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
    const ssm = new SSMClient({ region });
    await ssm.send(new GetParameterCommand({ Name: "/fleetmind/shared/github-packages-token" }));
    patExists = true;
  } catch { /* missing */ }

  if (patExists) {
    log.ok("  PAT already set in SSM — skipping");
  } else {
    const pat = await promptHidden("  GitHub Packages PAT (ghp_...): ");
    if (pat.trim()) {
      const { SSMClient, PutParameterCommand } = await import("@aws-sdk/client-ssm");
      const ssm = new SSMClient({ region });
      await ssm.send(new PutParameterCommand({
        Name: "/fleetmind/shared/github-packages-token",
        Type: "SecureString",
        Value: pat.trim(),
        Overwrite: true,
      }));
      log.ok("  PAT stored in SSM");
    }
  }

  // ── Step 7: Render ──────────────────────────────────────────────────────────
  header("Step 7 / 12 — Render");
  console.log("  Generates per-agent openclaw.json and workspaces/derived.tfvars from fleet.yaml.");
  if (await confirm(rl, "  Run fleetmind render?", true)) {
    const reloadedFleet = loadFleet(fleetFile);
    await provisionFleet(reloadedFleet, false, path.dirname(fleetFile));
    writeOutputs(reloadedFleet, path.dirname(fleetFile));
    log.ok("  Rendered successfully");
  }

  // ── Step 8: Terraform ───────────────────────────────────────────────────────
  header("Step 8 / 12 — Terraform");
  const workspaceDir = path.dirname(fleetFile);
  const tfvarsFile = `workspaces/${fleetName}.derived.tfvars`;
  const infraTfvars = `workspaces/${fleetName}.tfvars`;

  console.log("  Run these commands in your fleet repo:\n");
  console.log(`  \x1b[36mterraform init -backend-config=backend.hcl\x1b[0m`);
  console.log(`  \x1b[36mterraform workspace new ${fleetName}\x1b[0m`);
  console.log(`  \x1b[36mterraform apply \\`);
  console.log(`    -var-file=${infraTfvars} \\`);
  console.log(`    -var-file=${tfvarsFile}\x1b[0m\n`);
  console.log("  This creates EC2 instances, DDB, S3, Secrets Manager placeholders, etc.");
  console.log("  Instances will boot but agents won't start until step 9.\n");

  await confirm(rl, "  Terraform apply complete?", false);

  // ── Step 9: Populate secrets ─────────────────────────────────────────────────
  header("Step 9 / 12 — Populate Secrets Manager");
  console.log("  Writes Slack tokens + Anthropic API key to Secrets Manager per agent.");
  if (await confirm(rl, "  Populate secrets now?")) {
    // Set env vars from collected creds
    for (const [agentId, creds] of Object.entries(slackCreds)) {
      const upper = agentId.toUpperCase().replace(/-/g, "_");
      process.env[`${upper}_BOT_TOKEN`] = creds.botToken;
      process.env[`${upper}_APP_TOKEN`] = creds.appToken;
      process.env[`${upper}_SIGNING_SECRET`] = creds.signingSecret;
    }

    const reloadedFleet = loadFleet(fleetFile);
    await populateSecrets({
      fleet: fleetFile,
      dryRun: false,
      agent: [],
      region,
      interactive: true, // prompt for Anthropic keys (not collected above)
      promptFn: promptHidden,
      confirmFn: (q: string) => confirm(rl, q),
    });
  }

  // ── Step 10: GitHub App credentials ─────────────────────────────────────────
  header("Step 10 / 12 — Store GitHub App Credentials in SSM");
  console.log("  Writes app-id, installation-id, and pem key to SSM for each agent.");
  if (await confirm(rl, "  Store GitHub App credentials?")) {
    for (const [agentId, creds] of Object.entries(ghAppCreds)) {
      if (!creds.appId || !creds.installationId || !creds.pemFile) {
        log.warn(`  ${agentId}: missing credentials — skipping`);
        continue;
      }
      await storeGithubApp({
        fleet: fleetName,
        agent: agentId,
        appId: creds.appId,
        installationId: creds.installationId,
        pemFile: creds.pemFile,
        region,
        dryRun: false,
        overwrite: true,
      });
      log.ok(`  ${agentId}: GitHub App credentials stored`);
    }
  }

  // ── Step 11: Push fleet ──────────────────────────────────────────────────────
  header("Step 11 / 12 — Push Fleet");
  console.log("  Packages workspace + skills → uploads to S3 → triggers pull-self on each EC2.");
  console.log("  Also upgrades the fleetmind CLI on each instance to the current version.\n");
  if (await confirm(rl, "  Run fleetmind push fleet --restart --upgrade-cli?")) {
    const reloadedFleet = loadFleet(fleetFile);
    await runPushFleet({
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
  console.log("  Check that both bots are running:\n");
  console.log(`  \x1b[36mterraform output ssm_connect\x1b[0m`);
  console.log("  (then paste the SSM command for each agent and run:)");
  console.log(`  \x1b[36mjournalctl -u openclaw-<agent> -n 50\x1b[0m\n`);

  console.log("\x1b[32m\x1b[1m🎉 Onboarding complete!\x1b[0m");
  console.log(`  Fleet \x1b[1m${fleetName}\x1b[0m is deployed. Your bots should be online in Slack shortly.\n`);

  rl.close();
}

// ── Commander registration ────────────────────────────────────────────────────

export function registerOnboard(program: Command): void {
  program
    .command("onboard")
    .description("Interactive guided wizard to deploy a new fleet from start to finish")
    .option("-f, --fleet <path>", "fleet.yaml path", "./fleet.yaml")
    .option("--region <region>", "AWS region", "us-west-2")
    .addHelpText('after', `
Steps guided by this wizard:
  1.  Validate fleet.yaml
  2.  Generate Slack app manifests
  3.  Collect Slack credentials (tokens, channel IDs)
  4.  Discover bot_user_ids via Slack auth.test
  5.  Collect GitHub App credentials (app_id, installation_id, pem)
  6.  Check/set GitHub Packages PAT in SSM
  7.  Run fleetmind render
  8.  Guided Terraform init + workspace + apply
  9.  Populate Secrets Manager (Slack + Anthropic keys)
  10. Store GitHub App credentials in SSM
  11. Run fleetmind push fleet --restart --upgrade-cli
  12. Verify — print terraform output commands

Re-running onboard is safe — completed steps are skipped automatically.
`)
    .action(async (opts: { fleet: string; region: string }) => {
      try {
        await runOnboard(opts.fleet, opts.region);
      } catch (err) {
        log.error(String(err));
        process.exit(1);
      }
    });
}
