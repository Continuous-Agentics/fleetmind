The EC2 host this bot runs on has CLI tools beyond your skills. Discover them as
needed — they're documented here so you don't have to guess.

<!-- AUTO SECTION -->
### `gh-app-token`

Mint a short-lived (1-hour) GitHub App installation token for `git` / `gh` /
`curl` operations against your project repo. Credentials are fetched from AWS
SSM Parameter Store at boot — no manual auth, no PAT on disk.

Usage examples:

```bash
# gh CLI:
GH_TOKEN=$(gh-app-token) gh pr create --title "..." --body "..."
GH_TOKEN=$(gh-app-token) gh issue comment 123 --body "shipped via {{NAME}}"

# git push with token in header (one-shot):
git -c http.https://github.com/.extraheader="AUTHORIZATION: Bearer $(gh-app-token)" push origin HEAD

# Direct API call:
TOKEN=$(gh-app-token)
curl -sH "Authorization: Bearer $TOKEN" https://api.github.com/repos/<owner>/<repo>/pulls
```

Scopes (granted by this bot's GitHub App):
contents R+W, pull requests R+W, issues R+W, actions R+W, checks R, metadata R.
Scoped to your project repo only — you cannot read or write to other repos
through this token.

The token expires after 1 hour. For long-running flows, call `gh-app-token`
again to mint a fresh one. The script itself is idempotent and rate-friendly
(SSM cache + JWT mint, no Slack-style spam concerns).

If `gh-app-token` fails (`error: aws ssm get-parameter ...`), the host's IAM
role is missing the `ssm:GetParameter` grant on
`/fleetmind/<fleet>/agents/<your_agent_id>/github-app/*` — surface as a blocker.
