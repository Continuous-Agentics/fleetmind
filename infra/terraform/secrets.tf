# ── Secrets Manager — per-agent Slack tokens ─────────────────────────────────
#
# Creates placeholder secrets for each agent.
# After `terraform apply`, populate each secret with real values:
#
#   aws secretsmanager put-secret-value \
#     --secret-id fleetmind/agents/orchestrator/slack \
#     --secret-string '{"SLACK_BOT_TOKEN":"xoxb-...","SLACK_SIGNING_SECRET":"...","SLACK_APP_TOKEN":"xapp-..."}'
#
# The agent's user_data script fetches these at start time.

resource "aws_secretsmanager_secret" "agent_slack" {
  for_each = toset(var.agent_names)

  name                    = "${var.fleet_name}/agents/${each.key}/slack"
  description             = "Slack tokens for ${var.fleet_name} agent: ${each.key}"
  recovery_window_in_days = 7

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

# ── Shared ANTHROPIC_KEY ──────────────────────────────────────────────────────
resource "aws_secretsmanager_secret" "anthropic" {
  name                    = "${var.fleet_name}/shared/anthropic"
  description             = "Shared Anthropic API key for all ${var.fleet_name} agents"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "anthropic_placeholder" {
  secret_id     = aws_secretsmanager_secret.anthropic.id
  secret_string = local.anthropic_placeholder

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
      "ANTHROPIC_API_KEY": "REPLACE_ME_sk-ant-...",
      "DATABASE_URL": "POPULATED_AFTER_RDS_APPLY"
    }
  JSON
}
