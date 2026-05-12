# GitHub Apps for FleetMind Agents

## Why GitHub Apps?

FleetMind agents often need to push code, open PRs, and manage issues in their project repos. GitHub Apps are the right tool for this:

- **Scoped to specific repos** — each agent's app is installed only on its own project repo
- **Per-agent audit trail** — commits and API calls appear as `<agent-name>[bot]`, not a shared human account
- **Short-lived tokens** — 1-hour installation tokens auto-renewed on demand; a leaked token expires quickly
- **No seat cost** — GitHub Apps don't consume GitHub licenses

Compared to a shared Personal Access Token (PAT):

| | Shared PAT | GitHub App (per agent) |
|---|---|---|
| **Credential lifetime** | Long-lived (months/years) | 1-hour tokens, auto-renewed |
| **Blast radius** | All repos | Per-agent, per-repo |
| **Audit trail** | One human's identity | Per-agent bot identity |
| **Revocation** | Kills every consumer | Per-agent, independent |
| **Seat cost** | Consumes a GitHub seat | Free |

## Model: One App Per Agent

Each FleetMind agent that needs GitHub access gets its own GitHub App installed only on its project repo.

| | |
|---|---|
| **Purpose** | Push code, open PRs, manage issues in the agent's project repo |
| **Permissions** | Contents R+W, Pull requests R+W, Issues R+W, Actions R+W, Checks R, Metadata R |
| **Installed on** | Only `<org>/<project-repo>` |
| **Who uses it** | That one agent |

**Example:** A `helloworld` agent in the `myfleet` fleet gets "MyFleet HelloWorld Bot" installed only on `myorg/helloworld`.

## Token Lifecycle

GitHub Apps use a two-step credential flow — no long-lived secrets on disk:

```
Private Key (PEM) → JWT (10 min) → Installation Token (1 hour)
```

1. The agent calls `gh-app-token` which signs a JWT using the app's private key (valid 10 minutes)
2. It exchanges the JWT for a 1-hour **installation access token** via the GitHub API
3. The token is used for git and API operations
4. When the token expires, `gh-app-token` is called again to get a fresh one

Credentials (App ID, Installation ID, PEM) are stored in AWS SSM Parameter Store and fetched at runtime. The PEM is stored as a `SecureString` (encrypted at rest). The agent's IAM role grants read-only access to only its own SSM path.

## SSM Credential Paths

```
/fleetmind/<fleet_name>/agents/<agent_id>/github-app/app-id            (String)
/fleetmind/<fleet_name>/agents/<agent_id>/github-app/installation-id    (String)
/fleetmind/<fleet_name>/agents/<agent_id>/github-app/pem                (SecureString)
```

**Example** for agent `forge` in fleet `myfleet`:
```
/fleetmind/myfleet/agents/forge/github-app/app-id
/fleetmind/myfleet/agents/forge/github-app/installation-id
/fleetmind/myfleet/agents/forge/github-app/pem
```

## Using `gh-app-token`

The `gh-app-token` script is deployed to every agent EC2 at `/usr/local/bin/gh-app-token` by the bootstrap template.

```bash
# Get a 1-hour read+write token for this agent's project repo
gh-app-token

# Explicit (equivalent)
gh-app-token --app project

# Use in a git operation
TOKEN=$(gh-app-token)
git clone "https://x-access-token:${TOKEN}@github.com/myorg/myrepo.git"

# Use for direct API calls
TOKEN=$(gh-app-token)
curl -H "Authorization: Bearer ${TOKEN}" https://api.github.com/repos/myorg/myrepo/pulls
```

The script reads agent identity from `/etc/fleetmind/agent.env` (written by the bootstrap template) and uses it to construct the SSM path. Override with environment variables for local testing:

```bash
# Local testing — bypass SSM entirely
GH_APP_ID=12345678 \
GH_INSTALLATION_ID=987654321 \
GH_APP_PEM_FILE=~/Downloads/my-bot.pem \
  gh-app-token
```

## Creating a New App

When provisioning a new agent that needs GitHub access:

### Step 1 — Create the app in the GitHub UI

1. Navigate to your GitHub org: `https://github.com/organizations/<org>/settings/apps/new`
2. Fill in:
   - **App name:** `<FleetName> <AgentName> Bot` (e.g., "MyFleet Forge Bot")
   - **Homepage URL:** `https://github.com/<org>/<project-repo>`
   - **Webhook:** Disabled — uncheck "Active"
3. Set **Repository permissions**:
   - Contents: `Read and write`
   - Pull requests: `Read and write`
   - Issues: `Read and write`
   - Actions: `Read and write`
   - Checks: `Read`
   - Metadata: `Read` (mandatory, auto-selected)
4. **Where can this be installed:** "Only on this account"
5. Click **Create GitHub App**

> Add Workflows or Variables permissions only if your agent needs them — the defaults above are intentionally minimal.

### Step 2 — Generate a private key

On the app's settings page, scroll to **Private keys** and click **Generate a private key**. A `.pem` file downloads to your machine.

### Step 3 — Install on the project repo

1. In the app settings, click **Install App** (left sidebar)
2. Click **Install** next to your org
3. Choose **Only select repositories** → pick `<org>/<project-repo>`
4. Click **Install**
5. Note the **Installation ID** from the URL:
   `https://github.com/organizations/<org>/settings/installations/<INSTALLATION_ID>`

### Step 4 — Store credentials in SSM

**Preferred (CLI):**

```bash
fleetmind github-app store \
  --fleet <fleet_name> \
  --agent <agent_id> \
  --app-id <app-id> \
  --installation-id <installation-id> \
  --pem-file /path/to/private-key.pem
```

Add `--dry-run` to preview what would be written without calling AWS.

**Fallback (bash, no Node runtime required):**

```bash
infra/scripts/store-bot-github-app.sh \
  --fleet <fleet_name> \
  --agent <agent_id> \
  --app-id <app-id> \
  --installation-id <installation-id> \
  --pem-file /path/to/private-key.pem
```

Both methods store:
- `app-id` and `installation-id` as plain `String` parameters
- `pem` as a `SecureString` (encrypted with the default SSM KMS key)

The operation is idempotent — safe to re-run if you rotate the private key.

### Step 5 — Verify

SSH into the agent EC2 and run:

```bash
gh-app-token
# Should print a token string to stdout, and "Token expires: ..." to stderr
```

---

## Phase 2 (Planned)

Phase 2 will add `fleetmind github-app create` that uses the GitHub App manifest flow to semi-automate Steps 1–3 above. Tracked in issue #<N>.
