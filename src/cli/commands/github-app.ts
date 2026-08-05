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
import readline from "node:readline/promises";
import { URL } from "node:url";
import { Command } from "commander";
import chalk from "chalk";
import { SSMClient, PutParameterCommand, DescribeParametersCommand, ParameterType } from "@aws-sdk/client-ssm";
import { log } from "../../utils/log.js";
import { buildManifest, type ManifestOptions } from "../../runtime/github-app-manifest.js";
import { mintAppJwt } from "../../runtime/github-app-jwt.js";
import { resolveGitHubAppConfig } from "../../runtime/github-app-permissions.js";
import { loadFleet } from "../../config/loader.js";
import type { GitHubAppConfig, GitHubAppDefinition } from "../../config/schema.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Minimal interface for the SSM send method — allows injection in tests. */
export interface SsmSendable {
  send(command: PutParameterCommand): Promise<unknown>;
}

export interface GithubAppStoreOptions {
  fleet: string;
  agent: string;
  /** `project` preserves the legacy namespace; named aliases use github-apps/<alias>. */
  app?: string;
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

const GITHUB_APP_ALIAS = /^[a-z][a-z0-9-]{0,62}$/;

/** Resolve a credential namespace without changing the legacy project-App path. */
export function githubAppNamespace(fleet: string, agent: string, app = "project"): string {
  if (!GITHUB_APP_ALIAS.test(app)) {
    throw new Error(`Invalid GitHub App alias: ${app}`);
  }
  const base = `/fleetmind/${fleet}/agents/${agent}`;
  return app === "project" ? `${base}/github-app` : `${base}/github-apps/${app}`;
}

/**
 * Resolve an agent's GitHub App settings from fleet.yaml and verify that a
 * named credential alias was explicitly declared for that agent. `project`
 * remains the implicit, backwards-compatible default App.
 */
export function resolveAgentGitHubApp(
  configPath: string,
  fleetName: string,
  agentId: string,
  app = "project",
): { role: string; githubAppConfig?: GitHubAppConfig; definition?: GitHubAppDefinition } {
  const fleet = loadFleet(configPath);
  if (fleet.fleet.name !== fleetName) {
    throw new Error(
      `Fleet name mismatch: --fleet '${fleetName}' does not match ${configPath} (${fleet.fleet.name})`,
    );
  }

  const agent = fleet.agents.list.find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new Error(`Agent '${agentId}' was not found in ${configPath}`);
  }

  const declaration = agent.github_apps?.[app];
  if (!declaration) {
    throw new Error(
      `GitHub App '${app}' is not declared for agent '${agentId}' in ${configPath}. ` +
        `Add it under github_apps before setup or import.`,
    );
  }
  const definition = app === "project" ? undefined : declaration as GitHubAppDefinition;

  const defaultConfig = agent.github_app ?? { permissions: {}, events: [] };
  const githubAppConfig = definition
    ? {
        permissions: { ...defaultConfig.permissions, ...definition.permissions },
        events: definition.events ?? defaultConfig.events,
      }
    : agent.github_app;
  return { role: agent.role, githubAppConfig, definition };
}

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
  /** `project` preserves the legacy namespace; named aliases use github-apps/<alias>. */
  app?: string;
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
  const namespace = githubAppNamespace(options.fleet, options.agent, options.app);

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
    app: options.app,
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
  /** `project` preserves the legacy namespace; named aliases use github-apps/<alias>. */
  app?: string;
  /** Agent's role (pm | worker | backend-worker | frontend-worker). Drives
   *  per-bot-type permission defaults from
   *  openclaw/<bot-type>/github-app-permissions.yaml. Falls back to 'worker'
   *  if omitted (matches the schema default for unspecified agents). */
  role?: string;
  /** Optional per-agent github_app override from fleet.yaml. Merged on top of
   *  the per-bot-type defaults. */
  githubAppConfig?: GitHubAppConfig;
  /** GitHub owner under which the App is registered. For org-owned Apps
   * (default) this is the org name; for user-owned Apps it's a personal
   * username. The operator picks the install target separately in the
   * GitHub UI — fleetmind doesn't constrain whether the App lands on one
   * repo, several, or all repos. */
  owner: string;
  /** If true, manifest posts to /organizations/<owner>/settings/apps/new
   * (org-owned App). If false, posts to /settings/apps/new and the App is
   * created under the operator's personal GitHub account. */
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

interface AppInstallation {
  id: number;
  account: { login: string; type: "User" | "Organization" };
  created_at: string;
}

export async function createGithubApp(options: GithubAppCreateOptions): Promise<GithubAppStoreResult> {
  if (!options.owner || options.owner.includes("/")) {
    throw new Error(`--owner must be a bare GitHub owner name (no slashes); got '${options.owner}'`);
  }
  const owner = options.owner;

  // ─── Pick callback port + state nonce ──────────────────────────────────────
  const callbackPort = options.callbackPort > 0 ? options.callbackPort : await findFreePort(8765);
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUrl = `http://localhost:${callbackPort}/callback`;

  // ─── Build manifest ────────────────────────────────────────────────────────
  // ─── Resolve permissions (per-bot-type defaults + per-agent override) ────
  const resolved = resolveGitHubAppConfig(options.role ?? "worker", options.githubAppConfig);
  log.dim(
    `  permissions: ${Object.keys(resolved.permissions).length} scopes` +
      ` (${resolved.source.permissionsFromManifest} from <${options.role ?? "worker"}>-bot manifest` +
      `, ${resolved.source.permissionsFromOverride} from per-agent override` +
      `${resolved.source.permissionsDropped > 0 ? `, ${resolved.source.permissionsDropped} dropped via 'none'` : ""})`,
  );

  const app = options.app ?? "project";
  // Validate before opening the browser-side manifest flow. This also keeps
  // direct callers from accidentally creating a credential namespace the
  // helper/IAM policy cannot address.
  githubAppNamespace(options.fleet, options.agent, app);

  const manifestOpts: ManifestOptions = {
    name: options.appName ?? (app === "project" ? `${options.fleet}-${options.agent}` : `${options.fleet}-${options.agent}-${app}`),
    redirectUrl,
    description: `Fleetmind agent: ${options.agent} (fleet: ${options.fleet})`,
    homepageUrl: options.homepageUrl,
    permissions: resolved.permissions,
    events: resolved.events,
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
  log.bold("Step 3 — install the App:");
  console.log(`  ${chalk.cyan(installUrl)}`);
  log.info(`Select one repo, several, or 'All repositories' under ${owner} and click 'Install'.`);
  log.info("");

  const installationId = await pollForAppInstallation({
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
    app,
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
  appId: number;
  pem: string;
  timeoutMs: number;
}

async function pollForAppInstallation(opts: PollOptions): Promise<number> {
  const deadline = Date.now() + opts.timeoutMs;
  const jwt = mintAppJwt(opts.pem, String(opts.appId));
  let lastStatus = 0;

  while (Date.now() < deadline) {
    const resp = await fetch(`https://api.github.com/app/installations`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    lastStatus = resp.status;
    if (resp.ok) {
      const installations = (await resp.json()) as AppInstallation[];
      if (installations.length > 0) {
        // App is freshly-created and should have at most 1 installation.
        // If there are multiple, pick the most recent.
        const sorted = [...installations].sort((a, b) => b.created_at.localeCompare(a.created_at));
        return sorted[0]!.id;
      }
      // App created but not yet installed — wait + retry
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (resp.status === 401) {
      throw new Error(`GitHub rejected the App JWT (401). The PEM may be malformed.`);
    }
    const body = await resp.text();
    throw new Error(`Installation lookup failed: ${resp.status} ${resp.statusText}\n${body}`);
  }
  throw new Error(
    `Timed out after ${opts.timeoutMs / 1000}s waiting for the App to be installed.\n` +
      `Last GitHub response code: ${lastStatus}. Install via the URL above and re-run.`,
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

async function confirmCredentialReplacement(action: string): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error(`${action} requires an interactive terminal confirmation; refusing to replace credentials non-interactively.`);
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${action}. Type 'replace' to continue: `);
    if (answer.trim() !== "replace") throw new Error("Credential replacement cancelled.");
  } finally {
    prompt.close();
  }
}

// ── Commander registration ────────────────────────────────────────────────────

export function registerGithubApp(program: Command): void {
  const githubApp = program
    .command("github-app")
    .description("Manage GitHub App credentials for fleet agents");

  githubApp
    .command("status")
    .description("Report declared GitHub App credential namespace status without reading values")
    .option("-c, --config <file>", "fleet.yaml path", "fleet.yaml")
    .option("--fleet <name>", "Optional fleet-name consistency assertion")
    .option("--agent <id>", "Limit to one declared agent")
    .option("--app <name>", "Limit to one declared App")
    .option("--region <region>", "AWS region", "us-west-2")
    .option("--json", "Emit JSON", false)
    .action(async (opts) => {
      try {
        const fleet = loadFleet(opts.config as string);
        if (opts.fleet && opts.fleet !== fleet.fleet.name) throw new Error(`Fleet name mismatch: --fleet '${opts.fleet}' does not match ${fleet.fleet.name}`);
        const agents = opts.agent ? fleet.agents.list.filter((a) => a.id === opts.agent) : fleet.agents.list;
        if (opts.agent && agents.length === 0) throw new Error(`Agent '${opts.agent}' was not found in ${opts.config}`);
        const entries = agents.flatMap((agent) => Object.keys(agent.github_apps ?? {}).map((app) => ({ agent: agent.id, app })));
        const filtered = opts.app ? entries.filter((entry) => entry.app === opts.app) : entries;
        if (opts.app && filtered.length === 0) throw new Error(`GitHub App '${opts.app}' is not declared by the selected agent(s)`);
        const client = new SSMClient({ region: opts.region as string });
        const results = await Promise.all(filtered.map(async (entry) => {
          const namespace = githubAppNamespace(fleet.fleet.name, entry.agent, entry.app);
          const expected = [`${namespace}/app-id`, `${namespace}/installation-id`, `${namespace}/pem`];
          try {
            const response = await client.send(new DescribeParametersCommand({
              ParameterFilters: [{ Key: "Name", Option: "Equals", Values: expected }],
            }));
            const count = response.Parameters?.length ?? 0;
            return { ...entry, namespace, status: count === 3 ? "ready" : count === 0 ? "missing" : "incomplete" };
          } catch (error) {
            const name = error instanceof Error ? error.name : "UnknownError";
            return { ...entry, namespace, status: "unreadable", error: name };
          }
        }));
        if (opts.json) console.log(JSON.stringify(results, null, 2));
        else for (const result of results) console.log(`${result.agent}/${result.app}: ${result.status}  ${result.namespace}`);
      } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  githubApp
    .command("import")
    .alias("store")
    .description("Import GitHub App credentials into AWS SSM Parameter Store (legacy: store)")
    .requiredOption("--fleet <name>", "Fleet name (used as SSM path namespace)")
    .requiredOption("--agent <id>", "Agent ID within the fleet")
    .requiredOption("--app <name>", "Declared GitHub App name (use --app project deliberately)")
    .option("-c, --config <file>", "fleet.yaml path", "fleet.yaml")
    .requiredOption("--app-id <id>", "GitHub App ID")
    .requiredOption("--installation-id <id>", "GitHub App Installation ID")
    .requiredOption("--pem-file <path>", "Path to the .pem private key file")
    .option("--region <region>", "AWS region", "us-west-2")
    .option("--dry-run", "Print what would be written without calling SSM", false)
    .option("--replace", "Replace existing credentials after explicit operator confirmation", false)
    .addHelpText("after", `
Examples:
  $ fleetmind github-app store \\
      --fleet acme-bots --agent pm-bot \\
      --app-id 123456 --installation-id 78901234 \\
      --pem-file ./github-app.pem
`)
    .action(async (opts) => {
      try {
        resolveAgentGitHubApp(opts.config as string, opts.fleet as string, opts.agent as string, opts.app as string);
        if (opts.replace && !opts.dryRun) await confirmCredentialReplacement("Replacing GitHub App credentials");
        const result = await storeGithubApp({
          fleet: opts.fleet as string,
          agent: opts.agent as string,
          app: opts.app as string,
          appId: opts.appId as string,
          installationId: opts.installationId as string,
          pemFile: opts.pemFile as string,
          region: opts.region as string,
          dryRun: opts.dryRun as boolean,
          overwrite: opts.replace as boolean,
        });
        printStoreResult(result, opts.dryRun as boolean);
      } catch (err: unknown) {
        log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  githubApp
    .command("setup")
    .alias("create")
    .description("Set up a declared GitHub App via the manifest flow (legacy: create)")
    .requiredOption("--fleet <name>", "Fleet name (used as SSM path namespace)")
    .requiredOption("--agent <id>", "Agent ID within the fleet")
    .requiredOption("--app <name>", "Declared GitHub App name (use --app project deliberately)")
    .option("--owner <name>", "GitHub owner for project (named Apps use their declared owner)")
    .option("--no-org", "Create as user-owned App instead of org-owned (default: org-owned)")
    .option("--app-name <name>", "Human-readable App name (default: '<fleet>-<agent>')")
    .option("--homepage-url <url>", "Homepage URL for the GitHub App (defaults to the fleetmind repo URL — GitHub rejects localhost here)")
    .option("--callback-port <port>", "Local callback port for the manifest redirect (default: auto-pick)", (v) => parseInt(v, 10), 0)
    .option("--region <region>", "AWS region", "us-west-2")
    .option("--dry-run", "Run the flow but skip the SSM write at the end", false)
    .option("--force", "Intentionally replace existing credentials", false)
    .option("--install-timeout-ms <ms>", "How long to wait for the operator to install on the repo (default: 300000 = 5 min)", (v) => parseInt(v, 10), 5 * 60 * 1000)
    .addHelpText("after", `
The flow has 4 steps:
  1. Print a one-click URL. You open it in a browser and click 'Create GitHub App'.
  2. GitHub redirects to a local callback; fleetmind exchanges the manifest code
     for App credentials (app_id, pem, slug).
  3. Print an install URL. You open it and select the target repo.
  4. fleetmind polls until the App is installed on the repo, then writes
     app_id, installation_id, and pem to the selected App namespace in SSM.

Examples:
  # Create + install + store for an org-owned App:
  $ fleetmind github-app create \\
      --fleet acme-bots --agent backend-worker \\
      --owner acme-corp

  # User-owned App (rare; default is org-owned):
  $ fleetmind github-app create --no-org \\
      --fleet acme-bots --agent pm \\
      --owner my-username

  # Dry-run: complete the GitHub side but skip the SSM write
  $ fleetmind github-app create \\
      --fleet acme-bots --agent pm \\
      --owner acme-corp --dry-run
`)
    .option("-c, --config <file>", "fleet.yaml path (used to resolve the agent's role + per-agent github_app override)", "fleet.yaml")
    .action(async (opts) => {
      try {
        // Look up agent role + github_app override from fleet.yaml so the
        // per-bot-type permission defaults + per-agent overrides flow through.
        // This matches what 'fleetmind onboard' passes when it calls
        // createGithubApp internally.
        let agentRole: string | undefined;
        let agentGithubApp: GitHubAppConfig | undefined;
        let definition: GitHubAppDefinition | undefined;
        try {
          const resolvedAgent = resolveAgentGitHubApp(
            opts.config as string,
            opts.fleet as string,
            opts.agent as string,
            opts.app as string,
          );
          agentRole = resolvedAgent.role;
          agentGithubApp = resolvedAgent.githubAppConfig;
          definition = resolvedAgent.definition;
        } catch (err) {
          // A named App is only safe when it was declared in fleet.yaml. Keep
          // the historical project-App fallback for existing users whose
          // config is unavailable at invocation time.
          throw err;
        }
        if (opts.app === "project" && !opts.owner) throw new Error("--owner is required when setting up --app project");
        if (opts.force && !opts.dryRun) await confirmCredentialReplacement("Replacing GitHub App credentials");

        const result = await createGithubApp({
          fleet: opts.fleet as string,
          agent: opts.agent as string,
          app: opts.app as string,
          role: agentRole,
          githubAppConfig: agentGithubApp,
          owner: (definition?.owner ?? opts.owner) as string,
          org: definition?.org ?? opts.org as boolean,
          appName: opts.appName as string | undefined,
          homepageUrl: opts.homepageUrl as string | undefined,
          callbackPort: opts.callbackPort as number,
          region: opts.region as string,
          dryRun: opts.dryRun as boolean,
          overwrite: opts.force as boolean,
          installPollTimeoutMs: opts.installTimeoutMs as number,
        });
        printStoreResult(result, opts.dryRun as boolean);
      } catch (err: unknown) {
        log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
