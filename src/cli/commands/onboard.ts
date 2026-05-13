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
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { Command } from "commander";
import { loadFleet } from "../../config/loader.js";
import { log } from "../../utils/log.js";
import { generateManifests } from "./slack.js";
import { discoverSlackBotUserIds } from "./slack.js";
import { populateSecrets } from "./populate.js";
import { storeGithubApp } from "./github-app.js";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  SSMClient,
  GetParameterCommand as SsmGetCommand,
  PutParameterCommand as SsmPutCommand,
} from "@aws-sdk/client-ssm";
import { runPushFleet } from "./push-fleet.js";
import { writeOutputs } from "../../runtime/renderer.js";
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

// ── Main wizard ───────────────────────────────────────────────────────────────

export async function runOnboard(fleetFile: string, region: string): Promise<void> {
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

  if (!await confirm("Start onboarding?")) {
    console.log("Aborted.");
    return;
  }

  // In-memory credential store (collected during the wizard, used later)
  const slackCreds: Record<string, { botToken: string; signingSecret: string; appToken: string }> = {};
  const ghAppCreds: Record<string, { appId: string; installationId: string; pemFile: string }> = {};

  // ── Step 2: Slack manifests ─────────────────────────────────────────────────
  if (!manifestsExist) {
    header("Step 2 / 12 — Generate Slack App Manifests");
    console.log("  Generates a YAML manifest for each agent that you paste into api.slack.com.");
    if (await confirm("  Generate manifests now?")) {
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
      const botToken = await hiddenPrompt(`    Bot Token (xoxb-...): `);
      const signingSecret = await hiddenPrompt(`    Signing Secret:       `);
      const appToken = await hiddenPrompt(`    App Token (xapp-...): `);
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
      const channelInput = await prompt("    Channel IDs: ");
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
      const botToken = await hiddenPrompt(`    Bot Token (xoxb-...): `);
      const signingSecret = await hiddenPrompt(`    Signing Secret:       `);
      const appToken = await hiddenPrompt(`    App Token (xapp-...): `);
      slackCreds[agent.id] = { botToken, signingSecret, appToken };
    }
  }

  // ── Helper: check if SSM param exists ────────────────────────────────────
  async function ssmExists(name: string): Promise<boolean> {
    const ssm = new SSMClient({ region });
    try { await ssm.send(new SsmGetCommand({ Name: name })); return true; } catch { return false; }
  }

  // ── Helper: get existing SM secret value ─────────────────────────────────
  async function getSecret(secretId: string): Promise<string | null> {
    const sm = new SecretsManagerClient({ region });
    try {
      const r = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
      return r.SecretString ?? null;
    } catch { return null; }
  }

  // ── Helper: write SM secret ───────────────────────────────────────────────
  async function putSecret(secretId: string, value: Record<string, string>): Promise<void> {
    const sm = new SecretsManagerClient({ region });
    await sm.send(new PutSecretValueCommand({
      SecretId: secretId,
      SecretString: JSON.stringify(value),
    }));
  }

  // ── Step 4: Discover bot_user_ids ───────────────────────────────────────────
  if (!allUserIdsSet) {
    header("Step 4 / 12 — Discover bot_user_ids");
    console.log("  Calls Slack auth.test using the tokens entered in step 3.");
    if (await confirm("  Run fleetmind slack discover?")) {
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
  header("Step 5 / 12 — GitHub Apps");
  console.log("  Each bot needs its own GitHub App for repo access (PRs, issues, etc.)");
  console.log("  → Go to https://github.com/organizations/YOUR-ORG/settings/apps/new");
  console.log("  → Create one app per agent, generate a private key (.pem), install it");
  console.log("  → Capture: App ID (from app settings page) + Installation ID (from install URL)\n");

  for (const agent of agents) {
    const ssmKey = `/fleetmind/${fleetName}/agents/${agent.id}/github-app/app-id`;
    const alreadyInSsm = await ssmExists(ssmKey);

    if (alreadyInSsm) {
      const override = await confirm(`  ${agent.emoji} ${agent.name}: GitHub App already in SSM. Override?`, false);
      if (!override) {
        log.ok(`  ${agent.name}: using existing GitHub App credentials`);
        continue;
      }
    } else {
      console.log(`\n\x1b[1m  ${agent.emoji} ${agent.name} (${agent.id})\x1b[0m`);
    }

    const appId = await prompt(`    App ID:          `);
    const installationId = await prompt(`    Installation ID: `);
    const pemFile = await prompt(`    PEM file path:   `);
    ghAppCreds[agent.id] = { appId: appId.trim(), installationId: installationId.trim(), pemFile: pemFile.trim() };
  }
  console.log();

  // ── Step 6: GitHub Packages PAT ─────────────────────────────────────────────
  header("Step 6 / 12 — GitHub Packages PAT");
  console.log("  Bots install the fleetmind CLI from GitHub Packages at bootstrap.");
  console.log(`  SSM path: /fleetmind/shared/github-packages-token  (region: ${region})`);

  if (await ssmExists("/fleetmind/shared/github-packages-token")) {
    log.ok("  PAT already set in SSM — skipping");
  } else {
    const pat = await hiddenPrompt("  GitHub Packages PAT (ghp_...): ");
    if (pat.trim()) {
      const ssm = new SSMClient({ region });
      await ssm.send(new SsmPutCommand({
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
  if (await confirm("  Run fleetmind render?")) {
    const reloadedFleet = loadFleet(fleetFile);
    await provisionFleet(reloadedFleet, false, path.dirname(fleetFile));
    writeOutputs(reloadedFleet, path.dirname(fleetFile));
    log.ok("  Rendered successfully");
  }

  // ── Step 8: Terraform ───────────────────────────────────────────────────────
  header("Step 8 / 12 — Terraform");
  const tfvarsFile = `workspaces/${fleetName}.derived.tfvars`;
  const infraTfvars = `workspaces/${fleetName}.tfvars`;

  console.log("  Run these commands in your fleet repo:\n");
  console.log(`  \x1b[36mterraform init -backend-config=backend.hcl\x1b[0m`);
  console.log(`  \x1b[36mterraform workspace new ${fleetName}\x1b[0m`);
  console.log(`  \x1b[36mterraform apply \\`);
  console.log(`    -var-file=${infraTfvars} \\`);
  console.log(`    -var-file=${tfvarsFile}\x1b[0m\n`);
  console.log("  Instances will boot but agents crash-loop until secrets are populated.\n");
  await confirm("  Terraform apply complete?", false);

  // ── Step 9: Populate Secrets Manager ────────────────────────────────────────
  header("Step 9 / 12 — Populate Secrets Manager");
  console.log("  Writes Slack tokens + Anthropic API key per agent.");
  console.log("  Slack tokens from step 3 are used automatically; only Anthropic key is prompted.\n");

  if (await confirm("  Populate secrets now?")) {
    for (const agent of agents) {
      console.log(`\n\x1b[1m  ${agent.emoji} ${agent.name} (${agent.id})\x1b[0m`);
      const slackSecretId = `${fleetName}/agents/${agent.id}/slack`;

      // ── Slack tokens ────────────────────────────────────────────────────────
      const collected = slackCreds[agent.id];
      const existingSlack = await getSecret(slackSecretId);
      const slackIsPlaceholder = !existingSlack || existingSlack.includes("REPLACE_ME");

      let writeSlack = false;
      let slackPayload: Record<string, string> | null = null;

      if (collected) {
        if (!slackIsPlaceholder) {
          // Already has real values — offer override
          writeSlack = await confirm("    Slack tokens already in SM. Override with step-3 values?", false);
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
        if (!slackIsPlaceholder && !await confirm("    Slack tokens already in SM. Override?", false)) {
          log.ok("    Slack tokens unchanged");
        } else {
          const botToken = await hiddenPrompt("    Bot Token (xoxb-...):      ");
          const signingSecret = await hiddenPrompt("    Signing Secret:           ");
          const appToken = await hiddenPrompt("    App Token (xapp-...):     ");
          slackPayload = { SLACK_BOT_TOKEN: botToken, SLACK_SIGNING_SECRET: signingSecret, SLACK_APP_TOKEN: appToken };
          writeSlack = true;
        }
      }

      if (writeSlack && slackPayload) {
        await putSecret(slackSecretId, slackPayload);
        log.ok("    Slack tokens written");
      }

      // ── Anthropic API key ────────────────────────────────────────────────────
      const anthropicSecretId = `${fleetName}/agents/${agent.id}/anthropic`;
      const existingAnthropicRaw = await getSecret(anthropicSecretId);
      const anthropicIsPlaceholder = !existingAnthropicRaw || existingAnthropicRaw.includes("REPLACE_ME");

      let writeAnthropicKey = anthropicIsPlaceholder;
      if (!anthropicIsPlaceholder) {
        writeAnthropicKey = await confirm("    Anthropic key already in SM. Override?", false);
      }
      if (writeAnthropicKey) {
        const apiKey = await hiddenPrompt("    Anthropic API key (sk-ant-...): ");
        if (apiKey.trim()) {
          await putSecret(anthropicSecretId, { ANTHROPIC_API_KEY: apiKey.trim() });
          log.ok("    Anthropic key written");
        }
      } else {
        log.ok("    Anthropic key unchanged");
      }
    }
  }

  // ── Step 10: GitHub App credentials ─────────────────────────────────────────
  header("Step 10 / 12 — Store GitHub App Credentials in SSM");
  const agentsWithNewCreds = Object.keys(ghAppCreds);
  if (agentsWithNewCreds.length === 0) {
    log.ok("Step 10: no new GitHub App credentials to store — skipping");
  } else if (await confirm("  Store GitHub App credentials?")) {
    for (const [agentId, creds] of Object.entries(ghAppCreds)) {
      if (!creds.appId || !creds.installationId || !creds.pemFile) {
        log.warn(`  ${agentId}: incomplete credentials — skipping`);
        continue;
      }
      if (!fs.existsSync(creds.pemFile)) {
        log.warn(`  ${agentId}: pem file not found at ${creds.pemFile} — skipping`);
        continue;
      }
      await storeGithubApp({
        fleet: fleetName, agent: agentId,
        appId: creds.appId, installationId: creds.installationId, pemFile: creds.pemFile,
        region, dryRun: false, overwrite: true,
      });
      log.ok(`  ${agentId}: GitHub App credentials stored`);
    }
  }

  // ── Step 11: Push fleet ──────────────────────────────────────────────────────
  header("Step 11 / 12 — Push Fleet");
  console.log("  Packages workspace + skills → uploads to S3 → triggers pull-self on each EC2.");
  console.log("  Also upgrades the fleetmind CLI on each instance to the current version.\n");
  if (await confirm("  Run fleetmind push fleet --restart --upgrade-cli?")) {
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
