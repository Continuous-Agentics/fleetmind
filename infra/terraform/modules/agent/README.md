# agent submodule

Provisions one Fleetmind bot's complete AWS footprint:

- *EC2 instance* — Amazon Linux 2023, private subnet, SSM-managed, bootstrapped via `user_data/agent_bootstrap.sh.tpl`.
- *IAM role + instance profile* — least-privilege scoping for SSM, CloudWatch Logs, this agent's secrets, the fleet ContextStore table (optional), and GitHub App SSM params.
- *Secrets Manager secrets* — per-agent placeholders for Slack tokens and Anthropic API key (operator populates real values out-of-band; `lifecycle.ignore_changes` preserves them).

Intended to be invoked from the root `terraform-aws-fleetmind` module via `for_each` over the agent names. Cross-cutting policies (task-ledger PM/worker grants) are attached separately by the `task-ledger` submodule using `iam_role_name` from this module.

## Key design choices

- *`context_store_table_arn` is optional.* Pass empty string when the fleet uses a non-DDB context-store backend; the DDB IAM policy is skipped.
- *`shared_secret_arns` (list)* — caller-supplied additional Secrets Manager ARNs to grant read access. Typically used for the RDS-managed master-user secret (`rds!db-<random>`) whose name AWS owns.
- *Hardcoded SSM paths under `/fleetmind/...`* — these match the agent runtime's expectations. Not a variable today; revisit if the runtime ever needs configurable paths.
