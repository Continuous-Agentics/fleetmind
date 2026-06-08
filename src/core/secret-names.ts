/**
 * Canonical AWS Secrets Manager naming for a FleetMind fleet.
 *
 * This module is the SINGLE SOURCE OF TRUTH on the JS side. The matching
 * Terraform locals live in `terraform-aws-fleetmind/modules/agent/main.tf`
 * (search for `provider_secret_names`). Any format change here MUST be made
 * in lockstep with the Terraform module and the parity fixture in
 * `src/test/secret-names-parity.test.ts`.
 *
 * Canonical layout (per agent):
 *   <fleet_name>/agents/<agent_id>/slack
 *   <fleet_name>/agents/<agent_id>/hooks
 *   <fleet_name>/agents/<agent_id>/providers/<provider>     (one per provider)
 *
 * The per-provider JSON payload is uniformly:
 *   { "<PROVIDER>_API_KEY": "<value>" }
 *
 * `provider` is the lowercase token from a `provider/model` string
 * (e.g. "anthropic", "openai", "google", "bedrock").
 */

export function agentSecretPrefix(fleetName: string, agentId: string): string {
  return `${fleetName}/agents/${agentId}`;
}

export function slackSecretName(fleetName: string, agentId: string): string {
  return `${agentSecretPrefix(fleetName, agentId)}/slack`;
}

export function hooksSecretName(fleetName: string, agentId: string): string {
  return `${agentSecretPrefix(fleetName, agentId)}/hooks`;
}

export function providerSecretName(
  fleetName: string,
  agentId: string,
  provider: string,
): string {
  return `${agentSecretPrefix(fleetName, agentId)}/providers/${provider.toLowerCase()}`;
}
