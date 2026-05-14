/**
 * GitHub App manifest construction for `fleetmind github-app create`.
 *
 * The manifest is JSON the operator POSTs (via browser) to GitHub's
 * /settings/apps/new endpoint. GitHub then redirects with a temporary
 * code that we exchange for App credentials.
 *
 * Permissions are scoped to what a typical fleetmind worker needs:
 *   contents:   write   — commit + push code
 *   pull_requests: write — open + comment + merge PRs
 *   issues:     write   — create + comment on issues
 *   actions:    write   — trigger workflows + view runs
 *   checks:     read    — observe CI status
 *   metadata:   read    — required default
 *
 * No webhook is configured by default (`url` omitted, `active: false`).
 * Fleetmind agents poll or are driven by Slack, not by GitHub webhooks.
 *
 * Spec: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */

export interface ManifestOptions {
  /** Human-readable App name. Shows up in GitHub UI; can be edited there. */
  name: string;
  /** URL GitHub redirects to after the operator clicks 'Create'. */
  redirectUrl: string;
  /** Human description (shows in App settings + on install screen). */
  description?: string;
  /** Homepage URL for the GitHub App.
   *
   * GitHub validates this field on manifest submission and **rejects
   * localhost / non-public URLs** with 'url wasn't supplied' (counter-intuitive
   * error). Default is the fleetmind repo URL — it's just App metadata,
   * operators can edit it in the GitHub App settings page after creation. */
  homepageUrl?: string;
  /** Permissions to declare on the App. If omitted, falls back to a
   *  reasonable default set (contents/pull_requests/issues/actions:write,
   *  checks/metadata:read). Callers typically derive this from the resolved
   *  per-bot-type + per-agent permission config. */
  permissions?: Record<string, "read" | "write" | "admin">;
  /** Webhook events to subscribe to. Defaults to empty. */
  events?: string[];
}

/** Fallback permission set when the caller doesn't supply one.
 *  Matches the original hardcoded scope this module shipped with so existing
 *  callers (and operators with no per-bot-type manifest) get the same
 *  behavior they had before. */
export const DEFAULT_PERMISSIONS: Record<string, "read" | "write" | "admin"> = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  actions: "write",
  checks: "read",
  metadata: "read",
};

/** Default homepage URL when the caller doesn't supply one. GitHub requires
 * a publicly-resolvable URL here; we use the fleetmind project page. */
export const DEFAULT_HOMEPAGE_URL = "https://github.com/Continuous-Agentics/fleetmind";

/** The wire-format manifest GitHub expects.
 *
 * Notable schema notes (caught the hard way):
 *  - 'url' (App homepage) must be a publicly-resolvable URL. Localhost fails
 *    validation with the misleading error 'url wasn't supplied'.
 *  - 'hook_attributes' is intentionally omitted. GitHub's documented schema
 *    for hook_attributes only specifies a 'url' field; passing
 *    `{ active: false }` (which we tried) fails validation and surfaces as
 *    'url wasn't supplied'. Omitting hook_attributes entirely creates the App
 *    with webhooks off by default, which is what fleetmind agents want.
 */
export interface GitHubAppManifest {
  name: string;
  url: string;
  description?: string;
  redirect_url: string;
  public: boolean;
  default_permissions: Record<string, "read" | "write" | "admin">;
  default_events: string[];
}

export function buildManifest(opts: ManifestOptions): GitHubAppManifest {
  return {
    name: opts.name,
    url: opts.homepageUrl ?? DEFAULT_HOMEPAGE_URL,
    description: opts.description ?? `Fleetmind agent App: ${opts.name}`,
    // hook_attributes deliberately omitted — see the type doc comment for why.
    // GitHub creates the App with webhooks off by default; that's what we want.
    redirect_url: opts.redirectUrl,
    public: false,
    default_permissions: opts.permissions ?? DEFAULT_PERMISSIONS,
    default_events: opts.events ?? [],
  };
}
