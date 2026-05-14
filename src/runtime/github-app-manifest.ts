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
  /** Optional homepage URL (defaults to the redirect host). */
  homepageUrl?: string;
}

/** The wire-format manifest GitHub expects. */
export interface GitHubAppManifest {
  name: string;
  url: string;
  description?: string;
  hook_attributes?: { active: boolean };
  redirect_url: string;
  public: boolean;
  default_permissions: Record<string, "read" | "write" | "admin">;
  default_events: string[];
}

export function buildManifest(opts: ManifestOptions): GitHubAppManifest {
  const fallbackHome = (() => {
    try {
      const u = new URL(opts.redirectUrl);
      return `${u.protocol}//${u.host}`;
    } catch {
      return opts.redirectUrl;
    }
  })();

  return {
    name: opts.name,
    url: opts.homepageUrl ?? fallbackHome,
    description: opts.description ?? `Fleetmind agent App: ${opts.name}`,
    hook_attributes: { active: false },
    redirect_url: opts.redirectUrl,
    public: false,
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      issues: "write",
      actions: "write",
      checks: "read",
      metadata: "read",
    },
    default_events: [],
  };
}
