/**
 * Tests for branded identifier validators.
 *
 * These guard the security-sensitive constraints: anything accepted here flows
 * into shell commands, paths, S3 keys, systemd units, env vars, and NATS
 * subjects, so rejection of unsafe input is the contract under test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FleetNameId,
  AgentIdId,
  SkillNameId,
  NatsSubjectPrefixId,
  WorkspaceBaseId,
  agentEnvPrefix,
} from "../core/identifiers.js";

describe("FleetName", () => {
  for (const ok of ["acme", "acme-fleet", "a1", "prod-fleet-2"]) {
    it(`accepts ${ok}`, () => assert.ok(FleetNameId.is(ok)));
  }
  for (const bad of [
    "A", // too short + uppercase
    "Acme", // uppercase
    "1fleet", // leading digit
    "-fleet", // leading hyphen
    "fleet-", // trailing hyphen
    "fleet--name", // consecutive hyphens
    "fleet_name", // underscore
    "fleet.name", // dot
    "x".repeat(57), // too long for "<name>-ledger"
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => assert.equal(FleetNameId.is(bad), false));
  }
  it("parse throws with context", () => {
    assert.throws(() => FleetNameId.parse("Bad", "fleet.name"), /fleet name.*fleet\.name/);
  });
});

describe("AgentId", () => {
  for (const ok of ["conductor", "pixel", "forge", "pm-bot", "a"]) {
    it(`accepts ${ok}`, () => assert.ok(AgentIdId.is(ok)));
  }
  for (const bad of [
    "Conductor", // uppercase
    "1bot", // leading digit
    "bot-", // trailing hyphen
    "../etc", // traversal / slash
    "a/b", // slash
    "a.b", // dot (breaks NATS subject token)
    "a b", // space
    "x".repeat(40), // too long
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => assert.equal(AgentIdId.is(bad), false));
  }
});

describe("SkillName", () => {
  for (const ok of ["taskflow", "bot-delegation", "ca-fleet-ops", "github", "skill_1", "v1.2"]) {
    it(`accepts ${ok}`, () => assert.ok(SkillNameId.is(ok)));
  }
  for (const bad of [
    "../evil", // traversal
    "a..b", // traversal substring
    "skill name", // space (shell)
    "skill;rm -rf", // shell metachars
    "Skill", // uppercase
    "/abs", // slash
    "$(whoami)", // command substitution
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => assert.equal(SkillNameId.is(bad), false));
  }
});

describe("NatsSubjectPrefix", () => {
  for (const ok of ["fleetmind", "fleetmind-prod", "fleetmind.prod", "a.b.c"]) {
    it(`accepts ${ok}`, () => assert.ok(NatsSubjectPrefixId.is(ok)));
  }
  for (const bad of [
    "fleet mind", // space
    "fleet.*", // wildcard
    "fleet.>", // wildcard
    ".leading", // empty leading token
    "trailing.", // empty trailing token
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => assert.equal(NatsSubjectPrefixId.is(bad), false));
  }
});

describe("WorkspaceBase", () => {
  for (const ok of ["/home/ec2-user/.openclaw", "/Users/openclaw/.openclaw", "/opt/openclaw/workspace"]) {
    it(`accepts ${ok}`, () => assert.ok(WorkspaceBaseId.is(ok)));
  }
  for (const bad of [
    "relative/path", // not absolute
    "~/.openclaw", // not absolute
    "/home/../etc", // traversal segment
    "/trailing ", // trailing whitespace
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => assert.equal(WorkspaceBaseId.is(bad), false));
  }
});

describe("agentEnvPrefix", () => {
  it("uppercases and converts hyphens to underscores", () => {
    assert.equal(agentEnvPrefix(AgentIdId.parse("conductor")), "CONDUCTOR");
    assert.equal(agentEnvPrefix(AgentIdId.parse("pm-bot")), "PM_BOT");
  });
});

describe("zod schemas brand on parse", () => {
  it("FleetNameSchema parses valid and rejects invalid", () => {
    assert.equal(FleetNameId.schema.parse("acme-fleet"), "acme-fleet");
    assert.throws(() => FleetNameId.schema.parse("Bad_Name"));
  });
});
