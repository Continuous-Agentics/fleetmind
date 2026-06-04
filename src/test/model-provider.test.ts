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

describe("providersForAgent (strict / explicit-only)", () => {
  it("returns the explicit providers list, lowercased and deduped", () => {
    assert.deepEqual(
      providersForAgent({ providers: ["Anthropic", "OpenAI", "anthropic"] }),
      ["anthropic", "openai"],
    );
  });
  it("preserves declared order", () => {
    assert.deepEqual(
      providersForAgent({ providers: ["openai", "anthropic"] }),
      ["openai", "anthropic"],
    );
  });
  it("throws when providers is missing", () => {
    assert.throws(
      () => providersForAgent({ agentId: "ranger", model: "anthropic/claude-sonnet-4-6" }),
      /Agent 'ranger' is missing required field `providers: \[\.\.\.\]`/,
    );
  });
  it("throws when providers is an empty list", () => {
    assert.throws(
      () => providersForAgent({ agentId: "ranger", providers: [] }),
      /missing required field `providers/,
    );
  });
  it("does not infer from model strings (the old fallback is gone)", () => {
    assert.throws(
      () => providersForAgent({ model: "openai/gpt-4o" }),
      /Explicit provider declaration is required/,
    );
  });
  it("does not infer from api_keys map (the old fallback is gone)", () => {
    assert.throws(
      () => providersForAgent({ apiKeys: { anthropic: "${ANTHROPIC_API_KEY}" } }),
      /Explicit provider declaration is required/,
    );
  });
});
