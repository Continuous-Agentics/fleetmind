/**
 * `fleetmind github-app` — manage GitHub App credentials for fleet agents.
 *
 * Subcommands:
 *   store    Push manually-obtained credentials into SSM (the manual path —
 *            operator created the App in the UI, downloaded the .pem).
 *   create   Run the GitHub App manifest flow: spin up a local callback,
 *            print a one-click URL, exchange the manifest code for App
 *            credentials, wait for the operator to install on a repo, then
 *            store everything in SSM.
 *
 * SSM paths written by both subcommands:
 *   /fleetmind/<fleet>/agents/<agent>/github-app/app-id            (String)
 *   /fleetmind/<fleet>/agents/<agent>/github-app/installation-id   (String)
 *   /fleetmind/<fleet>/agents/<agent>/github-app/pem               (SecureString)
 */

import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { Command } from "commander";
import chalk from "chalk";
import { SSMClient, PutParameterCommand, ParameterType } from "@aws-sdk/client-ssm";
import { log } from "../../utils/log.js";
import { buildManifest, type ManifestOptions } from "../../runtime/github-app-manifest.js";
import { mintAppJwt } from "../../runtime/github-app-jwt.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Minimal interface for the SSM send method — allows injection in tests. */
export interface SsmSendable {
  send(command: PutParameterCommand): Promise<unknown>;
}

export interface GithubAppStoreOptions {
  fleet: string;
  agent: string;
  appId: string;
  installationId: string;
  pemFile: string;
  region: string;
  dryRun: boolean;
  overwrite: boolean;
  /** Injectable SSM client for unit tests. When omitted a real SSMClient is created. */
  ssmClient?: SsmSendable;
}

export interface GithubAppStoreResult {
  namespace: string;
  region: string;
  params: Array<{
    name: string;
    type: ParameterType;
    valueHint: string;
    written: boolean; // false in dry-run
  }>;
}

// ── Shared SSM write ──────────────────────────────────────────────────────────

/**
 * Write GitHub App credentials to AWS SSM Parameter Store.
 *
 * Shared by `github-app store` (operator supplies PEM file) and
 * `github-app create` (PEM comes from the manifest exchange). Both call
 * paths produce identical SSM state.
 */
export interface WriteCredentialsOptions {
  fleet: string;
  agent: string;
  appId: string;
  installationId: string;
  pemContents: string;
  region: string;
  dryRun: boolean;
  overwrite: boolean;
  ssmClient?: SsmSendable;
}

export async function writeCredentialsToSsm(
  options: WriteCredentialsOptions,
): Promise<GithubAppStoreResult> {
  const trimmed = options.pemContents.trim();
  if (!trimmed) {
    throw new Error("PEM contents are empty");
  }

  const pemDigest = crypto.createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
  const namespace = `/fleetmind/${options.fleet}/agents/${options.agent}/github-app`;

  const params: GithubAppStoreResult["params"] = [
    { name: `${namespace}/app-id`, type: ParameterType.STRING, valueHint: options.appId, written: false },
    { name: `${namespace}/installation-id`, type: ParameterType.STRING, valueHint: options.installationId, written: false },
    { name: `${namespace}/pem`, type: ParameterType.SECURE_STRING, valueHint: `<redacted sha256:${pemDigest}...>`, written: false },
  ];

  const values: Record<string, string> = {
    [`${namespace}/app-id`]: options.appId,
    [`${namespace}/installation-id`]: options.installationId,
    [`${namespace}/pem`]: trimmed,
  };

  if (options.dryRun) {
    console.log(chalk.dim("\n[dry-run] Would write the following SSM parameters:"));
    for (const p of params) {
      const hint = p.type === ParameterType.SECURE_STRING ? "<redacted>" : p.valueHint;
      console.log(chalk.dim(`  ${p.name}  (${p.type})  = ${hint}`));
    }
    console.log(chalk.dim(`  region: ${options.region}`));
    console.log(chalk.dim(`  overwrite: ${options.overwrite}\n`));
    return { namespace, region: options.region, params };
  }

  const client: SsmSendable = options.ssmClient ?? new SSMClient({ region: options.region });
  for (const p of params) {
    await client.send(
      new PutParameterCommand({
        Name: p.name,
        Value: values[p.name]!,
        Type: p.type,
        Overwrite: options.overwrite,
      }),
    );
    p.written = true;
  }

  return { namespace, region: options.region, params };
}

// ── store (manual flow) ───────────────────────────────────────────────────────

export async function storeGithubApp(options: GithubAppStoreOptions): Promise<GithubAppStoreResult> {
  const pemPath = (() => {
    try { return fs.realpathSync(options.pemFile); }
    catch { return options.pemFile; }
  })();

  if (!fs.existsSync(pemPath)) {
    throw new Error(`PEM file not found: ${options.pemFile}`);
  }

  const pemContents = fs.readFileSync(pemPath, "utf-8");
  if (!pemContents.trim()) {
    throw new Error(`PEM file is empty: ${options.pemFile}`);
  }

  return writeCredentialsToSsm({
    fleet: options.fleet,
    agent: options.agent,
    appId: options.appId,
    installationId: options.installationId,
    pemContents,
    region: options.region,
    dryRun: options.dryRun,
    overwrite: options.overwrite,
    ssmClient: options.ssmClient,
  });
}

// ── create (manifest flow) ────────────────────────────────────────────────────

export interface GithubAppCreateOptions {
  fleet: string;
  agent: string;
  /** `<owner>/<repo>` — used to derive the install target + post-install lookup. */
  repo: string;
  /** If set, the manifest is posted to /organizations/<owner>/settings/apps/new
   * (org-owned App). If false, the manifest goes to /settings/apps/new and
   * the App is created under the operator's personal GitHub account. */
  org: boolean;
  /** Optional human-readable App name. Default: `<fleet>-<agent>`. */
  appName?: string;
  /** Optional homepage URL for the App (defaults to the fleetmind repo URL
   * — GitHub rejects localhost here). */
  homepageUrl?: string;
  /** Local callback port. 0 = pick free. */
  callbackPort: number;
  region: string;
  dryRun: boolean;
  overwrite: boolean;
  ssmClient?: SsmSendable;
  /** How long to wait for the operator to click "Install" before giving up. */
  installPollTimeoutMs?: number;
}

interface ManifestConversionResponse {
  id: number;
  slug: string;
  pem: string;
  webhook_secret: string | null;
  client_id: string;
  client_secret: string;
  owner: { login: string; type: "User" | "Organization" };
  html_url: string;
}

interface RepoInstallationResponse {
  id: number;
  account: { login: string };
}

export async function createGithubApp(options: GithubAppCreateOptions): Promise<GithubAppStoreResult> {
  const [owner, repo] = options.repo.split("/");
  if (!owner || !repo) {
    throw new Error(`--repo must be in '<owner>/<repo>' format; got '${options.repo}'`);
  }

  // ─── Pick callback port + state nonce ──────────────────────────────────────
  const callbackPort = options.callbackPort > 0 ? options.callbackPort : await findFreePort(8765);
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUrl = `http://localhost:${callbackPort}/callback`;

  // ─── Build manifest ────────────────────────────────────────────────────────
  const manifestOpts: ManifestOptions = {
    name: options.appName ?? `${options.fleet}-${options.agent}`,
    redirectUrl,
    description: `Fleetmind agent: ${options.agent} (fleet: ${options.fleet})`,
    homepageUrl: options.homepageUrl,
  };
  const manifest = buildManifest(manifestOpts);

  // GitHub's manifest flow requires a POST with the manifest in the form body,
  // not a GET with manifest as a query param. We serve a tiny HTML page at
  // GET / that auto-POSTs to GitHub. The operator opens http://localhost:<port>/
  // and the page submits itself to https://github.com/.../settings/apps/new.
  const githubPostUrl = options.org
    ? `https://github.com/organizations/${owner}/settings/apps/new?state=${state}`
    : `https://github.com/settings/apps/new?state=${state}`;

  const operatorEntryUrl = `http://localhost:${callbackPort}/`;

  log.bold(`GitHub App manifest flow for ${options.fleet}/${options.agent}`);
  log.info("");
  log.ok(`Local server ready at http://localhost:${callbackPort}`);
  log.info("");
  log.bold("Step 1 — open this URL in your browser:");
  console.log(`  ${chalk.cyan(operatorEntryUrl)}`);
  log.info("");
  log.info(`The page will auto-submit the manifest to GitHub.`);
  log.info(`Confirm the App name (default '${manifestOpts.name}') and click 'Create GitHub App'.`);
  log.info(`GitHub will redirect to ${redirectUrl} to complete the exchange.`);
  log.info("");

  // ─── Start local server, wait for redirect ─────────────────────────────────
  const { code: manifestCode, state: returnedState } = await waitForCallback(callbackPort, githubPostUrl, manifest);

  if (returnedState !== state) {
    throw new Error(`State mismatch — possible CSRF. Expected '${state}', got '${returnedState}'. Aborting.`);
  }
  log.dim(`  received manifest code (state verified)`);

  // ─── Exchange the manifest code for App credentials ────────────────────────
  log.bold("Step 2 — exchanging manifest code for App credentials...");
  const conversion = await exchangeManifestCode(manifestCode);
  log.ok(`App created: ${conversion.html_url}`);
  log.dim(`  app_id=${conversion.id}  slug=${conversion.slug}  owner=${conversion.owner.login} (${conversion.owner.type})`);

  // ─── Print install URL + wait for operator to install ──────────────────────
  const installUrl = `https://github.com/apps/${conversion.slug}/installations/new`;
  log.info("");
  log.bold("Step 3 — install the App on the target repo:");
  console.log(`  ${chalk.cyan(installUrl)}`);
  log.info(`Select '${owner}/${repo}' (or 'All repositories') and click 'Install'.`);
  log.info("");

  const installationId = await pollForRepoInstallation({
    owner,
    repo,
    appId: conversion.id,
    pem: conversion.pem,
    timeoutMs: options.installPollTimeoutMs ?? 5 * 60 * 1000,
  });
  log.ok(`Installation detected: installation_id=${installationId}`);

  // ─── Write to SSM ──────────────────────────────────────────────────────────
  log.info("");
  log.bold("Step 4 — writing credentials to SSM...");
  const result = await writeCredentialsToSsm({
    fleet: options.fleet,
    agent: options.agent,
    appId: String(conversion.id),
    installationId: String(installationId),
    pemContents: conversion.pem,
    region: options.region,
    dryRun: options.dryRun,
    overwrite: options.overwrite,
    ssmClient: options.ssmClient,
  });

  return result;
}

// ── Helpers: callback server, manifest exchange, install polling ────────────

function waitForCallback(
  port: number,
  githubPostUrl: string,
  manifest: object,
): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end("Missing URL");
        return;
      }
      const url = new URL(req.url, `http://localhost:${port}`);

      // GET / — serve the auto-submit form page. This is the operator's
      // entry point. The form POSTs to GitHub with the manifest as a form
      // field per https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const manifestJson = JSON.stringify(manifest);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderAutoSubmitPage(githubPostUrl, manifestJson));
        return;
      }

      // GET /callback — receive GitHub's redirect after the operator clicks Create
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) {
          res.writeHead(400);
          res.end("Missing code or state");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body style=\"font-family: sans-serif; padding: 2em;\">" +
            "<h2>✓ fleetmind: manifest code received</h2>" +
            "<p>You can close this tab and return to the terminal.</p></body></html>",
        );
        server.close();
        resolve({ code, state });
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Render a tiny HTML page that auto-submits a hidden form to GitHub. This is
 * the canonical entry point for the manifest flow per GitHub's docs. The
 * manifest must be in the POST body — a GET with manifest as a query param is
 * silently ignored by GitHub (shows the plain Create-App form instead).
 */
function renderAutoSubmitPage(githubPostUrl: string, manifestJson: string): string {
  // HTML-escape the manifest JSON so embedded quotes/angle-brackets are safe
  // inside the <input value="..."> attribute.
  const escaped = manifestJson
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>fleetmind — redirecting to GitHub…</title></head>
<body style="font-family: -apple-system, sans-serif; padding: 2em; max-width: 36em;">
  <h2>fleetmind: redirecting to GitHub…</h2>
  <p>Submitting the App manifest. If your browser doesn't redirect automatically,
     click the button below.</p>
  <form id="manifest-form" method="post" action="${githubPostUrl}">
    <input type="hidden" name="manifest" value="${escaped}">
    <button type="submit">Continue to GitHub</button>
  </form>
  <script>document.getElementById('manifest-form').submit();</script>
</body></html>`;
}

async function exchangeManifestCode(code: string): Promise<ManifestConversionResponse> {
  const resp = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitHub manifest conversion failed: ${resp.status} ${resp.statusText}\n${body}`);
  }
  return (await resp.json()) as ManifestConversionResponse;
}

interface PollOptions {
  owner: string;
  repo: string;
  appId: number;
  pem: string;
  timeoutMs: number;
}

async function pollForRepoInstallation(opts: PollOptions): Promise<number> {
  const deadline = Date.now() + opts.timeoutMs;
  const jwt = mintAppJwt(opts.pem, String(opts.appId));
  let lastStatus = 0;

  while (Date.now() < deadline) {
    const resp = await fetch(`https://api.github.com/repos/${opts.owner}/${opts.repo}/installation`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    lastStatus = resp.status;
    if (resp.ok) {
      const data = (await resp.json()) as RepoInstallationResponse;
      return data.id;
    }
    if (resp.status === 404) {
      // Not installed yet — wait + retry
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    // 401 → JWT expired or wrong; non-404 errors → bail with detail
    if (resp.status === 401) {
      throw new Error(`GitHub rejected the App JWT (401). The PEM may be malformed.`);
    }
    const body = await resp.text();
    throw new Error(`Installation lookup failed: ${resp.status} ${resp.statusText}\n${body}`);
  }
  throw new Error(
    `Timed out after ${opts.timeoutMs / 1000}s waiting for App to be installed on ${opts.owner}/${opts.repo}.\n` +
      `Last GitHub response code: ${lastStatus}. Install the App via the URL above and re-run.`,
  );
}

async function findFreePort(start: number): Promise<number> {
  const net = await import("node:net");
  for (let p = start; p < start + 20; p++) {
    const free = await new Promise<boolean>((resolve) => {
      const tester = net.createServer();
      tester.once("error", () => resolve(false));
      tester.once("listening", () => tester.close(() => resolve(true)));
      tester.listen(p, "127.0.0.1");
    });
    if (free) return p;
  }
  throw new Error(`No free local port in range ${start}–${start + 19}`);
}

// ── Output ────────────────────────────────────────────────────────────────────

export function printStoreResult(result: GithubAppStoreResult, dryRun: boolean): void {
  const action = dryRun ? chalk.dim("(dry-run — not written)") : chalk.green("written");

  console.log();
  log.ok(`GitHub App credentials ${dryRun ? "would be stored" : "stored"} in SSM`);
  console.log(`  namespace : ${chalk.cyan(result.namespace)}`);
  console.log(`  region    : ${chalk.cyan(result.region)}`);
  console.log();

  for (const p of result.params) {
    const hint = p.type === ParameterType.SECURE_STRING ? "<redacted>" : p.valueHint;
    console.log(`  ${chalk.bold(p.name)}`);
    console.log(`    type  : ${p.type}`);
    console.log(`    value : ${hint}`);
    console.log(`    status: ${action}`);
  }
  console.log();
}

// ── Commander registration ────────────────────────────────────────────────────

export function registerGithubApp(program: Command): void {
  const githubApp = program
    .command("github-app")
    .description("Manage GitHub App credentials for fleet agents");

  githubApp
    .command("store")
    .description("Push GitHub App credentials (app-id, installation-id, pem) into AWS SSM Parameter Store")
    .requiredOption("--fleet <name>", "Fleet name (used as SSM path namespace)")
    .requiredOption("--agent <id>", "Agent ID within the fleet")
    .requiredOption("--app-id <id>", "GitHub App ID")
    .requiredOption("--installation-id <id>", "GitHub App Installation ID")
    .requiredOption("--pem-file <path>", "Path to the .pem private key file")
    .option("--region <region>", "AWS region", "us-west-2")
    .option("--dry-run", "Print what would be written without calling SSM", false)
    .option("--no-overwrite", "Fail if a parameter already exists (default: overwrite)")
    .addHelpText("after", `
Examples:
  $ fleetmind github-app store \\
      --fleet acme-bots --agent pm-bot \\
      --app-id 123456 --installation-id 78901234 \\
      --pem-file ./github-app.pem
`)
    .action(async (opts) => {
      try {
        const result = await storeGithubApp({
          fleet: opts.fleet as string,
          agent: opts.agent as string,
          appId: opts.appId as string,
          installationId: opts.installationId as string,
          pemFile: opts.pemFile as string,
          region: opts.region as string,
          dryRun: opts.dryRun as boolean,
          overwrite: opts.overwrite as boolean,
        });
        printStoreResult(result, opts.dryRun as boolean);
      } catch (err: unknown) {
        log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  githubApp
    .command("create")
    .description("Create a GitHub App via the manifest flow, then store its credentials in SSM")
    .requiredOption("--fleet <name>", "Fleet name (used as SSM path namespace)")
    .requiredOption("--agent <id>", "Agent ID within the fleet")
    .requiredOption("--repo <owner/repo>", "Target repo for App installation, e.g. 'acme-corp/their-fleet'")
    .option("--no-org", "Create as user-owned App instead of org-owned (default: org-owned)")
    .option("--app-name <name>", "Human-readable App name (default: '<fleet>-<agent>')")
    .option("--homepage-url <url>", "Homepage URL for the GitHub App (defaults to the fleetmind repo URL — GitHub rejects localhost here)")
    .option("--callback-port <port>", "Local callback port for the manifest redirect (default: auto-pick)", (v) => parseInt(v, 10), 0)
    .option("--region <region>", "AWS region", "us-west-2")
    .option("--dry-run", "Run the flow but skip the SSM write at the end", false)
    .option("--no-overwrite", "Fail if a SSM parameter already exists (default: overwrite)")
    .option("--install-timeout-ms <ms>", "How long to wait for the operator to install on the repo (default: 300000 = 5 min)", (v) => parseInt(v, 10), 5 * 60 * 1000)
    .addHelpText("after", `
The flow has 4 steps:
  1. Print a one-click URL. You open it in a browser and click 'Create GitHub App'.
  2. GitHub redirects to a local callback; fleetmind exchanges the manifest code
     for App credentials (app_id, pem, slug).
  3. Print an install URL. You open it and select the target repo.
  4. fleetmind polls until the App is installed on the repo, then writes
     app_id, installation_id, and pem to SSM under
     /fleetmind/<fleet>/agents/<agent>/github-app/*.

Examples:
  # Create + install + store for a client's backend worker:
  $ fleetmind github-app create \\
      --fleet acme-bots --agent backend-worker \\
      --repo acme-corp/api-service

  # User-owned App (rare; default is org-owned):
  $ fleetmind github-app create --no-org \\
      --fleet acme-bots --agent pm \\
      --repo my-username/my-repo

  # Dry-run: complete the GitHub side but skip the SSM write
  $ fleetmind github-app create \\
      --fleet acme-bots --agent pm \\
      --repo acme-corp/api-service --dry-run
`)
    .action(async (opts) => {
      try {
        const result = await createGithubApp({
          fleet: opts.fleet as string,
          agent: opts.agent as string,
          repo: opts.repo as string,
          org: opts.org as boolean,
          appName: opts.appName as string | undefined,
          homepageUrl: opts.homepageUrl as string | undefined,
          callbackPort: opts.callbackPort as number,
          region: opts.region as string,
          dryRun: opts.dryRun as boolean,
          overwrite: opts.overwrite as boolean,
          installPollTimeoutMs: opts.installTimeoutMs as number,
        });
        printStoreResult(result, opts.dryRun as boolean);
      } catch (err: unknown) {
        log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
