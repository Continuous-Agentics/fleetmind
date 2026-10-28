import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Command } from "commander";
import yaml from "js-yaml";
import { createTaskEvents, TaskLedger, NatsTaskEvents } from "@continuous-agentics/delegation-core";
import { FleetSchema, NatsConfigSchema } from "../config/schema.js";
import { normalizeFleet } from "../core/model.js";
import { registerTask } from "../cli/commands/task.js";
import { publishConfiguredTaskEvent, taskEventsConfig } from "../runtime/delegation/task-events.js";
import { renderAgentFleetYaml, renderAgentOpenClawJson } from "../runtime/renderer.js";
import { prepareOpenClawConfig } from "../cli/commands/pull-self.js";

// Resolve the actual SDK used by the frozen core candidate, without installing packages.
const sdk = createRequire(import.meta.resolve("@continuous-agentics/delegation-core"))("@aws-sdk/client-sqs");
const transport = { provider: "sqs" as const, pmQueueUrl: "https://sqs.us-west-2.amazonaws.com/123456789012/pm",
  workerQueueUrls: { worker: "https://sqs.us-west-2.amazonaws.com/123456789012/worker" } };
function input(enabled = true, sqs = true) {
  return { fleet: { name: "connection" },
    delegation: { enabled, table_name: "existing-tasks", s3_bucket: "existing-narratives", aws_region: "us-west-2",
      ...(sqs ? { taskEventTransport: transport } : {}) },
    targets: { pmhost: { provider: "local" }, workerhost: { provider: "local" } },
    agents: { list: [{ id: "pm", name: "PM", orchestrator: true, target: "pmhost" },
      { id: "worker", name: "Worker", target: "workerhost" }] } };
}
const event = { v: "1.0" as const, event: "delegation" as const, task_id: "a1b2c3d4", project: "project",
  worker: "worker", delegated_by: "pm", at: "2026-10-28T00:00:00Z" };

test("production task create publishes stored delegation to the configured worker using the real factory", async t => {
  assert.equal(typeof createTaskEvents, "function");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "producer-connection-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fleetPath = path.join(dir, "fleet.yaml");
  fs.writeFileSync(fleetPath, yaml.dump(input()));
  const order: string[] = [];
  const commands: any[] = [];
  t.mock.method(TaskLedger.prototype, "createTask", async (record: any) => {
    order.push("write");
    return { ...record, delegated_at: event.at, tracker_link: null,
      delivery_context: { provider: "discord", accountId: "trusted", conversationId: "thread" } };
  });
  t.mock.method(sdk.SQSClient.prototype, "send", async (command: any) => {
    order.push("publish");
    commands.push(command);
    return {};
  });
  const program = new Command();
  registerTask(program);
  await program.parseAsync(["task", "create", "--fleet", fleetPath, "--project", "project", "--worker", "worker",
    "--delegated-by", "pm", "--dod", "Ship it", "--task-id", event.task_id, "--json"], { from: "user" });
  assert.deepEqual(order, ["write", "publish"]);
  assert.equal(commands.length, 1);
  const command = commands[0];
  assert.equal(command.constructor.name, "SendMessageCommand");
  assert.equal(command.input.QueueUrl, transport.workerQueueUrls.worker);
  const message = JSON.parse(command.input.MessageBody);
  assert.equal(message.event, "delegation");
  assert.equal(message.worker, "worker");
  assert.equal(message.delegated_by, "pm");
  assert.equal(message.definition_of_done, "Ship it");
  assert.equal(message.at, event.at);
  assert.deepEqual(message.delivery_context, { provider: "discord", accountId: "trusted", conversationId: "thread" });
});

test("disabled delegation never constructs a transport", async () => {
  await publishConfiguredTaskEvent(FleetSchema.parse(input(false)).delegation, event, () => { throw new Error("must not construct"); });
});

test("omission keeps NATS defaults and maps legacy producer options", () => {
  const fleet = normalizeFleet(FleetSchema.parse(input(true, false)));
  assert.ok(fleet.delegation!.nats);
  const slice: any = yaml.load(renderAgentFleetYaml(fleet, "worker"));
  assert.deepEqual(taskEventsConfig(slice.delegation), { provider: "nats", servers: ["nats://nats.connection.internal:4222"],
    subjectPrefix: "fleetmind", timeout: 5000, maxReconnectAttempts: -1, inboxPrefix: "_INBOX" });
  assert.equal((renderAgentOpenClawJson(fleet, "worker") as any).plugins.entries["fleetmind-delegation"], undefined);
});

test("default producer uses the shared NATS adapter and closes it", async t => {
  const delegation = FleetSchema.parse(input(true, false)).delegation!;
  delegation.nats = NatsConfigSchema.parse({ servers: ["nats://operator.example:4222"] });
  const received: unknown[] = [];
  t.mock.method(NatsTaskEvents.prototype, "publish", async (value: unknown) => { received.push(value); });
  let closed = false;
  t.mock.method(NatsTaskEvents.prototype, "close", async () => { closed = true; });
  await publishConfiguredTaskEvent(delegation, event);
  assert.deepEqual(received, [event]);
  assert.equal(closed, true);
});

test("trusted SQS selection survives fleet slicing, rendering and pull-self preparation", t => {
  const fleet = normalizeFleet(FleetSchema.parse(input()));
  assert.equal(fleet.delegation!.nats, undefined);
  const slice: any = yaml.load(renderAgentFleetYaml(fleet, "worker"));
  assert.deepEqual(slice.delegation.taskEventTransport, transport);
  for (const id of ["pm", "worker"]) {
    const rendered: any = renderAgentOpenClawJson(fleet, id);
    const config = rendered.plugins.entries["fleetmind-delegation"].config;
    assert.deepEqual(config.taskEventTransport, transport);
    assert.deepEqual(config.workerAgentIds, { worker: "worker" });
    assert.equal(config.terminalEvents?.pmAgentId, id === "pm" ? "pm" : undefined);
    assert.equal(config.delegationEvents?.agentId, id === "worker" ? "worker" : undefined);
    assert.ok(rendered.plugins.allow.includes("fleetmind-delegation"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-connection-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const incoming = path.join(dir, "incoming.json");
    fs.writeFileSync(incoming, JSON.stringify(rendered));
    const prepared = prepareOpenClawConfig(incoming, path.join(dir, "live.json"), dir);
    assert.deepEqual(prepared.candidate.plugins.entries["fleetmind-delegation"].config, config);
  }
  const disabled: any = renderAgentOpenClawJson(normalizeFleet(FleetSchema.parse(input(false))), "worker");
  assert.equal(disabled.plugins.entries["fleetmind-delegation"], undefined);
});

test("queue URLs are operator configuration; invalid or shared inboxes are rejected", () => {
  for (const pmQueueUrl of ["http://untrusted/queue", transport.workerQueueUrls.worker, "https://sqs.example/queue.fifo"]) {
    const value = input(); value.delegation.taskEventTransport = { ...transport, pmQueueUrl };
    assert.equal(FleetSchema.safeParse(value).success, false);
  }
});

test("a missing SQS factory reports the explicit package gate", async () => {
  await assert.rejects(publishConfiguredTaskEvent(FleetSchema.parse(input()).delegation, event, null as any), /factory unavailable/);
});
