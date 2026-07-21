/**
 * Parity test: these strings MUST match the Terraform locals in
 * terraform-aws-fleetmind/modules/agent/main.tf (search `provider_secret_names`).
 *
 * If you change either side's format, you must update the other AND this
 * fixture in the same change. The whole point of this test is to fail loudly
 * before a mismatched CLI hits ResourceNotFoundException against a stack
 * provisioned by the wrong-shape TF module (the exact failure that motivated
 * the per-provider secrets refactor).
 *
 * Companion: `terraform-aws-fleetmind/modules/agent/main.tf` locals:
 *   agent_secret_prefix = "${var.fleet_name}/agents/${var.name}"
 *   provider_secret_names = {
 *     for p in var.model_providers : p => "${local.agent_secret_prefix}/providers/${p}"
 *   }
 * and the slack/hooks/gateway resources:
 *   name = "${var.fleet_name}/agents/${var.name}/slack"
 *   name = "${var.fleet_name}/agents/${var.name}/hooks"
 *   name = "${var.fleet_name}/agents/${var.name}/gateway"
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  agentSecretPrefix,
  slackSecretName,
  hooksSecretName,
  gatewaySecretName,
  providerSecretName,
} from "../core/secret-names.js";

const FLEET = "fleetmind-test-111122223333";
const AGENT = "ranger";

describe("secret-names parity (CLI ⇄ terraform-aws-fleetmind module)", () => {
  it("agentSecretPrefix matches TF local.agent_secret_prefix", () => {
    assert.equal(agentSecretPrefix(FLEET, AGENT), `${FLEET}/agents/${AGENT}`);
  });

  it("slackSecretName matches TF aws_secretsmanager_secret.slack.name", () => {
    assert.equal(slackSecretName(FLEET, AGENT), `${FLEET}/agents/${AGENT}/slack`);
  });

  it("hooksSecretName matches TF aws_secretsmanager_secret.hooks.name", () => {
    assert.equal(hooksSecretName(FLEET, AGENT), `${FLEET}/agents/${AGENT}/hooks`);
  });

  it("gatewaySecretName matches TF aws_secretsmanager_secret.gateway.name", () => {
    assert.equal(gatewaySecretName(FLEET, AGENT), `${FLEET}/agents/${AGENT}/gateway`);
  });

  it("providerSecretName(anthropic) matches TF provider_secret_names[anthropic]", () => {
    assert.equal(
      providerSecretName(FLEET, AGENT, "anthropic"),
      `${FLEET}/agents/${AGENT}/providers/anthropic`,
    );
  });

  it("providerSecretName(openai) matches TF provider_secret_names[openai]", () => {
    assert.equal(
      providerSecretName(FLEET, AGENT, "openai"),
      `${FLEET}/agents/${AGENT}/providers/openai`,
    );
  });

  it("provider name is lowercased — guards against mixed-case fleet.yaml entries", () => {
    assert.equal(
      providerSecretName(FLEET, AGENT, "Anthropic"),
      `${FLEET}/agents/${AGENT}/providers/anthropic`,
    );
  });
});
