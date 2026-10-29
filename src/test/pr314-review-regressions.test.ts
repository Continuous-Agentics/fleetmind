import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import yaml from "js-yaml";
import * as core from "@continuous-agentics/delegation-core";
import { TaskLedger, NatsTaskEvents } from "@continuous-agentics/delegation-core";
import { FleetSchema } from "../config/schema.js";
import { normalizeFleet } from "../core/model.js";
import { renderAgentOpenClawJson, renderHostOpenClawJson } from "../runtime/renderer.js";
import { mergeCanonicalConfigs } from "../runtime/openclaw-config.js";
import { registerTask } from "../cli/commands/task.js";

const transport = { provider: "sqs", pmQueueUrl: "https://sqs.us-west-2.amazonaws.com/123456789012/pm",
  workerQueueUrls: { worker: "https://sqs.us-west-2.amazonaws.com/123456789012/worker" } };
const slack = (account_id: string, channels: string[]) => ({ provider: "slack", account_id,
  bot_token: "test-bot-reference", app_token: "test-app-reference", bot_user_id: "UTEST", channels });
function fleetInput() {
  return { fleet: { name: "review314" }, targets: { pmhost: { provider: "local" }, workerhost: { provider: "local" } },
    delegation: { enabled: true, table_name: "tasks", s3_bucket: "narratives", aws_region: "us-west-2", taskEventTransport: transport },
    agents: { list: [
      { id: "pm", name: "PM", orchestrator: true, target: "pmhost", channels: [slack("pm-account", ["CPMHOME"])] },
      { id: "worker", name: "Worker", target: "workerhost", channels: [slack("worker-account", ["CWORKHOME", "CSHARED"])] },
    ] } };
}

test("PR314 worker home uses the configured worker account and first channel at both render boundaries", () => {
  const fleet = normalizeFleet(FleetSchema.parse(fleetInput()));
  for (const rendered of [renderAgentOpenClawJson(fleet, "worker"), renderHostOpenClawJson(fleet, "workerhost")]) {
    const config = (rendered as any).plugins.entries["fleetmind-delegation"].config;
    assert.deepEqual(config.delegationEvents, { agentId: "worker",
      workerHomeSlack: { accountId: "worker-account", conversationId: "CWORKHOME" } });
    assert.deepEqual(Object.keys((rendered as any).channels.slack.accounts), ["worker-account"]);
  }
  for (const rendered of [renderAgentOpenClawJson(fleet, "pm"), renderHostOpenClawJson(fleet, "pmhost")]) {
    assert.equal((rendered as any).plugins.entries["fleetmind-delegation"].config.delegationEvents, undefined);
  }
});

test("PR314 missing worker home never invents a route or borrows the PM home", () => {
  for (const channels of [[], [slack("worker-account", [])], [slack("", ["CWORKHOME"])], [slack("worker-account", ["placeholder", "CWORKHOME"])]]) {
    const value = fleetInput(); value.agents.list[1]!.channels = channels;
    const fleet = normalizeFleet(FleetSchema.parse(value));
    for (const rendered of [renderAgentOpenClawJson(fleet, "worker"), renderHostOpenClawJson(fleet, "workerhost")]) {
      assert.deepEqual((rendered as any).plugins.entries["fleetmind-delegation"].config.delegationEvents, { agentId: "worker" });
    }
  }
});

// Only authored model-policy leaves are fleet-owned: operator-only model keys,
// params and sibling settings remain three-way merged, including deletions.
for (const scope of ["entry", "defaults"] as const) {
  const cfg = (models: Record<string, any>) => ({ agents: scope === "entry"
    ? { entries: { worker: { models, tools: { deny: ["browser"] } } } }
    : { defaults: { models, contextTokens: 32000 } } });
  const policy = (config: any) => scope === "entry" ? config.agents.entries.worker : config.agents.defaults;
  test("PR314 " + scope + " authored runtime/params win actual three-way conflicts without replacing operator policy", () => {
    const base = cfg({ "openai/*": { agentRuntime: { id: "openclaw" }, params: { cacheRetention: "short" } },
      "old/model": { agentRuntime: { id: "codex" } } });
    const live = structuredClone(base);
    policy(live).models["openai/*"] = { agentRuntime: { id: "operator-runtime" }, params: { cacheRetention: "none", temperature: 0.4 } };
    policy(live).models["operator/model"] = { agentRuntime: { id: "operator-only" } };
    policy(live).models["old/model"].agentRuntime.id = "operator-old";
    policy(live).operatorSetting = { keep: true };
    const incoming = cfg({ "openai/*": { agentRuntime: { id: "codex" }, params: { cacheRetention: "long" } } });
    for (const baseline of [base, undefined]) {
      const merged = mergeCanonicalConfigs(incoming, live, baseline);
      assert.deepEqual(policy(merged).models["openai/*"], { agentRuntime: { id: "codex" },
        params: { cacheRetention: "long", temperature: 0.4 } });
      assert.deepEqual(policy(merged).models["operator/model"], { agentRuntime: { id: "operator-only" } });
      assert.deepEqual(policy(merged).operatorSetting, { keep: true });
      assert.deepEqual(scope === "entry" ? policy(merged).tools : policy(merged).contextTokens,
        scope === "entry" ? { deny: ["browser"] } : 32000);
      if (baseline) assert.equal(policy(merged).models["old/model"], undefined);
      assert.deepEqual(policy(mergeCanonicalConfigs(incoming, merged, incoming)), policy(merged));
    }
  });
  test("PR314 " + scope + " omission removes previously owned runtime without manufacturing defaults or erasing operator leaves", () => {
    const base = cfg({ "openai/*": { agentRuntime: { id: "codex" }, params: { cacheRetention: "short" } } });
    const live = structuredClone(base);
    policy(live).models["openai/*"].agentRuntime.id = "operator-runtime";
    policy(live).models["openai/*"].params.temperature = 0.4;
    const incoming = cfg({ "openai/*": { params: { cacheRetention: "long" } } });
    const merged = mergeCanonicalConfigs(incoming, live, base);
    assert.deepEqual(policy(merged).models["openai/*"], { params: { cacheRetention: "long", temperature: 0.4 } });
    const absent = cfg({}); delete policy(absent).models;
    assert.equal(policy(mergeCanonicalConfigs(absent, base, base)).models, undefined);
    assert.deepEqual(policy(mergeCanonicalConfigs(absent, live)).models, policy(live).models);
    const withoutLocalRuntime = structuredClone(base);
    delete policy(withoutLocalRuntime).models["openai/*"].agentRuntime;
    assert.deepEqual(policy(mergeCanonicalConfigs(base, withoutLocalRuntime, base)).models["openai/*"].agentRuntime, { id: "codex" });
    const untouched = structuredClone(base); policy(untouched).models["openai/*"].params = { cacheRetention: "none" };
    assert.equal(policy(mergeCanonicalConfigs(base, untouched, base)).models["openai/*"].params.cacheRetention, "short");
    const removed = structuredClone(base); delete policy(removed).models["openai/*"].params;
    const withLocal = structuredClone(base); policy(withLocal).models["openai/*"].params.operatorOnly = true;
    delete policy(withLocal).models["openai/*"].params.cacheRetention;
    assert.deepEqual(policy(mergeCanonicalConfigs(removed, withLocal, base)).models["openai/*"].params, { operatorOnly: true });
  });
}

test("PR314 real task CLI rejects missing SQS capability before rows, success output or notification", async t => {
  assert.equal("createTaskEvents" in core, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr314-preflight-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fleet.yaml"); fs.writeFileSync(file, yaml.dump(fleetInput()));
  const rows: unknown[] = [], notifications: unknown[] = [], output: unknown[] = [];
  t.mock.method(TaskLedger.prototype, "createTask", async (record: Parameters<TaskLedger["createTask"]>[0]) => {
    rows.push(record);
    return { ...record, delegated_at: "2026-10-29T00:00:00Z", tracker_link: null };
  });
  t.mock.method(NatsTaskEvents.prototype, "publish", async (event: unknown) => { notifications.push(event); });
  t.mock.method(console, "log", (...args: unknown[]) => { output.push(args); });
  for (const mode of [[], ["--json"]]) {
    const program = new Command(); registerTask(program);
    await assert.rejects(program.parseAsync(["task", "create", "--fleet", file, "--project", "test", "--worker", "worker",
      "--delegated-by", "pm", "--dod", "Ship it", "--task-id", "a1b2c3d4", ...mode], { from: "user" }), /factory unavailable/);
  }
  assert.equal(rows.length, 0, "unsupported SQS must not leave a durable task or consume its ID");
  assert.deepEqual(output, [], "neither human nor JSON success output is allowed");
  assert.deepEqual(notifications, []);
});

test("PR314 real task CLI with a typed SQS factory constructs and publishes only after the ledger write", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr314-factory-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fleet.yaml"); fs.writeFileSync(file, yaml.dump(fleetInput()));
  const order: string[] = [];
  let stored: Pick<Awaited<ReturnType<TaskLedger["createTask"]>>, "task_id" | "delegated_at" | "delivery_context" | "tracker_link"> | undefined;
  t.mock.method(TaskLedger.prototype, "createTask", async (record: Parameters<TaskLedger["createTask"]>[0]) => {
    order.push("write-start");
    await Promise.resolve();
    stored = { ...record, delegated_at: "2026-10-29T00:00:00Z", tracker_link: null,
      delivery_context: { provider: "slack", accountId: "pm-account", conversationId: "CPMHOME", threadId: "1234567890.123456" } };
    order.push("write-committed");
    return stored;
  });
  t.mock.method(console, "log", () => { order.push("output"); });
  // Only the new optional factory API is mocked. The CLI, config loader and
  // notification mapper are real; the installed core remains published 0.1.2.
  const factory: import("../runtime/delegation/task-events.js").TaskEventFactory = config => {
    assert.ok(stored, "factory must not be constructed during preflight");
    assert.deepEqual(config, { ...transport, region: "us-west-2" });
    order.push("construct");
    return {
      async publish(event) {
        assert.ok(stored);
        assert.equal(event.task_id, stored.task_id);
        assert.equal(event.at, stored.delegated_at);
        assert.deepEqual(event.delivery_context, stored.delivery_context);
        order.push("publish");
      },
      async close() { order.push("close"); },
    };
  };
  const program = new Command(); registerTask(program, factory);
  await program.parseAsync(["task", "create", "--fleet", file, "--project", "test", "--worker", "worker",
    "--delegated-by", "pm", "--dod", "Ship it", "--task-id", "a1b2c3d4", "--json"], { from: "user" });
  assert.deepEqual(order, ["write-start", "write-committed", "output", "construct", "publish", "output", "close"]);
});
