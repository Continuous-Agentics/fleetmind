import { test } from "node:test";
import assert from "node:assert/strict";
import { FleetSchema } from "../config/schema.js";
import { normalizeFleet } from "../core/model.js";
import { renderAgentOpenClawJson, renderHostOpenClawJson, renderOpenClawJson } from "../runtime/renderer.js";
import { mergeCanonicalConfigs } from "../runtime/openclaw-config.js";

const slack = (account: string) => ({ provider: "slack", account_id: account, bot_token: `synthetic-bot-${account}`, app_token: `synthetic-app-${account}` });
function makeFleet(mixed: boolean) {
  return normalizeFleet(FleetSchema.parse({ fleet: { name: "channels" },
    targets: { one: { provider: "local", os: "linux" }, two: { provider: "local", os: "linux" } },
    agents: { defaults: { target: "one", plugins: [] }, list: [
      { id: "silent", name: "Silent", orchestrator: true },
      { id: "worker", name: "Worker", channels: mixed ? [slack("default")] : [] },
      { id: "remote", name: "Remote", target: "two", channels: mixed ? [slack("remote-account")] : [] },
      { id: "remote-silent", name: "Remote Silent", target: "two" },
    ] } }));
}
function assertRoutes(config: Record<string, any>, routes: [string, string][]) {
  assert.deepEqual(config.bindings, routes.map(([agentId, accountId]) => ({ agentId, match: { channel: "slack", accountId } })));
  assert.deepEqual(Object.keys(config.channels.slack?.accounts ?? {}).sort(), routes.map(([, account]) => account).sort());
  assert.ok(!JSON.stringify(config).includes("/slack/undefined"));
  if (!routes.length) {
    assert.equal(config.channels.slack, undefined, "no enabled implicit default Slack account");
    assert.equal(config.plugins.entries.slack, undefined, "no inferred Slack plugin without an authored channel/plugin");
  } else {
    assert.equal(config.channels.slack.enabled, true);
    assert.equal(config.channels.slack.groupPolicy, "allowlist");
    assert.equal(config.plugins.entries.slack.enabled, true);
    for (const [, account] of routes) assert.deepEqual(config.channels.slack.accounts[account], {
      enabled: true, botToken: `synthetic-bot-${account}`, appToken: `synthetic-app-${account}`, webhookPath: `/slack/${account}`,
    });
  }
  // Production merge on real schema-normalized renders, first sync and replay.
  const incoming = JSON.parse(JSON.stringify(config));
  const first = mergeCanonicalConfigs(incoming, {});
  const once = mergeCanonicalConfigs(incoming, first, incoming);
  const twice = mergeCanonicalConfigs(incoming, once, incoming);
  assert.deepEqual(twice, once);
  assert.deepEqual(mergeCanonicalConfigs(incoming, incoming, incoming), incoming);
  assert.deepEqual(once.bindings, config.bindings);
}

test("channel-less agent, shared host, and multiple hosts render and reconcile without phantom Slack routes", () => {
  const fleet = makeFleet(false);
  for (const agent of fleet.agents.list) assertRoutes(renderAgentOpenClawJson(fleet, agent.id), []);
  for (const host of ["one", "two"]) assertRoutes(renderHostOpenClawJson(fleet, host), []);
  assertRoutes(renderOpenClawJson(fleet), []);
});

test("mixed channel/no-channel hosts preserve only intentional Slack accounts, including explicit default", () => {
  const fleet = makeFleet(true);
  assertRoutes(renderAgentOpenClawJson(fleet, "silent"), []);
  assertRoutes(renderAgentOpenClawJson(fleet, "worker"), [["worker", "default"]]);
  assertRoutes(renderAgentOpenClawJson(fleet, "remote"), [["remote", "remote-account"]]);
  assertRoutes(renderHostOpenClawJson(fleet, "one"), [["worker", "default"]]);
  assertRoutes(renderHostOpenClawJson(fleet, "two"), [["remote", "remote-account"]]);
  assertRoutes(renderOpenClawJson(fleet), [["worker", "default"], ["remote", "remote-account"]]);
});

test("authored duplicate Slack routes still fail closed and legacy meaningful default ownership survives", () => {
  const parsed = FleetSchema.parse({ fleet: { name: "duplicates" },
    targets: { box: { provider: "local", os: "linux" } }, agents: { defaults: { target: "box" }, list: [
    { id: "one", name: "One", channels: [slack("default")] },
    { id: "two", name: "Two", channels: [slack("default")] },
  ] } });
  const incoming = renderOpenClawJson(normalizeFleet(parsed));
  assert.throws(() => mergeCanonicalConfigs(incoming, incoming, incoming), /binding ownership conflict/);
  const legacy = { agents: { list: [{ id: "one", default: true }, { id: "two" }] }, channels: { slack: { botToken: "synthetic", appToken: "synthetic" } } };
  const migrated = mergeCanonicalConfigs(legacy, legacy, legacy);
  assert.deepEqual(migrated.bindings, [{ agentId: "one", match: { channel: "slack", accountId: "default" } }]);
  assert.deepEqual(mergeCanonicalConfigs(migrated, migrated, migrated), migrated);
});
