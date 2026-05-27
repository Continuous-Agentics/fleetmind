/**
 * Tests for the model-provider helpers — the conventions that let FleetMind
 * stage an API key for whatever provider an agent's `model` names. The
 * "anthropic" cases lock byte-for-byte compatibility with the original
 * Anthropic-only naming so the runtime secret contract is preserved.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  modelProvider,
  providerApiKeyVar,
  agentProviderApiKeyVar,
  providersForAgent,
} from "../core/model-provider.js";

describe("modelProvider", () => {
  it("extracts the provider prefix, lowercased", () => {
    assert.equal(modelProvider("anthropic/claude-sonnet-4-6"), "anthropic");
    assert.equal(modelProvider("openai/gpt-4o"), "openai");
    assert.equal(modelProvider("Google/gemini-2.0-flash"), "google");
  });
  it("returns null when there is no provider prefix", () => {
    assert.equal(modelProvider("claude-sonnet-4-6"), null);
    assert.equal(modelProvider("/leading-slash"), null);
    assert.equal(modelProvider(""), null);
    assert.equal(modelProvider(undefined), null);
  });
});

describe("providerApiKeyVar", () => {
  it("is compatible with the legacy ANTHROPIC_API_KEY name", () => {
    assert.equal(providerApiKeyVar("anthropic"), "ANTHROPIC_API_KEY");
  });
  it("generalizes to other providers", () => {
    assert.equal(providerApiKeyVar("openai"), "OPENAI_API_KEY");
    assert.equal(providerApiKeyVar("google-vertex"), "GOOGLE_VERTEX_API_KEY");
  });
});

describe("agentProviderApiKeyVar", () => {
  it("prefixes the agent id (legacy anthropic shape)", () => {
    assert.equal(agentProviderApiKeyVar("conductor", "anthropic"), "CONDUCTOR_ANTHROPIC_API_KEY");
  });
  it("normalizes hyphenated agent ids to env-safe tokens", () => {
    assert.equal(agentProviderApiKeyVar("pm-bot", "openai"), "PM_BOT_OPENAI_API_KEY");
  });
});

describe("providersForAgent", () => {
  it("derives the provider from the agent's own model", () => {
    assert.deepEqual(providersForAgent({ model: "openai/gpt-4o" }), ["openai"]);
  });
  it("falls back to the fleet default model when the agent has none", () => {
    assert.deepEqual(
      providersForAgent({ defaultModel: "anthropic/claude-sonnet-4-6" }),
      ["anthropic"]
    );
  });
  it("unions the model provider with explicit api_keys providers (model first)", () => {
    assert.deepEqual(
      providersForAgent({
        model: "anthropic/claude-sonnet-4-6",
        apiKeys: { openai: "${OPENAI_API_KEY}", anthropic: "${ANTHROPIC_API_KEY}" },
      }),
      ["anthropic", "openai"]
    );
  });
  it("falls back to anthropic when nothing can be derived", () => {
    assert.deepEqual(providersForAgent({}), ["anthropic"]);
  });
});
