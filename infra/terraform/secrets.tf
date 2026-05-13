# ── Secrets Manager — per-agent Slack tokens and Anthropic API keys ──────────
#
# Creates placeholder secrets for each agent.
# After `terraform apply`, populate each secret with real values:
#
#   aws secretsmanager put-secret-value \
#     --secret-id fleetmind/agents/orchestrator/slack \
#     --secret-string '{"SLACK_BOT_TOKEN":"xoxb-...","SLACK_SIGNING_SECRET":"...","SLACK_APP_TOKEN":"xapp-..."}'
#
#   aws secretsmanager put-secret-value \
#     --secret-id fleetmind/agents/orchestrator/anthropic \
#     --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-..."}'
#
# The agent's user_data script fetches these at start time.

resource "aws_secretsmanager_secret" "agent_slack" {
  for_each = toset(var.agent_names)

  name                    = "${var.fleet_name}/agents/${each.key}/slack"
  description             = "Slack tokens for ${var.fleet_name} agent: ${each.key}"
  recovery_window_in_days = var.secret_recovery_window_days

  tags = { Agent = each.key }
}

resource "aws_secretsmanager_secret_version" "agent_slack_placeholder" {
  for_each = toset(var.agent_names)

  secret_id     = aws_secretsmanager_secret.agent_slack[each.key].id
  secret_string = local.slack_placeholder

  # Don't overwrite if someone has already populated the secret
  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ── Per-agent Anthropic API keys ─────────────────────────────────────────────
resource "aws_secretsmanager_secret" "agent_anthropic" {
  for_each = toset(var.agent_names)

  name                    = "${var.fleet_name}/agents/${each.key}/anthropic"
  description             = "Anthropic API key for ${var.fleet_name} agent: ${each.key}"
  recovery_window_in_days = var.secret_recovery_window_days

  tags = { Agent = each.key }
}

resource "aws_secretsmanager_secret_version" "agent_anthropic_placeholder" {
  for_each = toset(var.agent_names)

  secret_id     = aws_secretsmanager_secret.agent_anthropic[each.key].id
  secret_string = local.anthropic_placeholder

  # Don't overwrite if someone has already populated the secret
  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ── Placeholder values (plain locals — no encoding functions) ─────────────────
locals {
  slack_placeholder = <<-JSON
    {
      "SLACK_BOT_TOKEN": "REPLACE_ME_xoxb-...",
      "SLACK_SIGNING_SECRET": "REPLACE_ME",
      "SLACK_APP_TOKEN": "REPLACE_ME_xapp-..."
    }
  JSON

  anthropic_placeholder = <<-JSON
    {
      "ANTHROPIC_API_KEY": "REPLACE_ME_sk-ant-..."
    }
  JSON
}
