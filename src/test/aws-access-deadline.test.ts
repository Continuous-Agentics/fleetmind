import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { EventEmitter } from "node:events";
import { STSClient } from "@aws-sdk/client-sts";
import { runAwsTask, withAwsAuthorization } from "../runtime/aws-access-aws.js";
import { RuntimeAwsAccess } from "../config/aws-access.js";

const source = async () => ({ accessKeyId: "synthetic", secretAccessKey: "synthetic", sessionToken: "synthetic", expiration: new Date(Date.now() + 900_000) });
const catalog = RuntimeAwsAccess.parse({ version: 1, agent: "worker", source_role_arn: "arn:aws:iam::111111111111:role/host", source_region: "us-west-2", targets: { app: { app: "app", environment: "test", access: "read", account_id: "222222222222", role_arn: "arn:aws:iam::222222222222:role/app", region: "us-west-2" } } });

test("MF3: actual STS serialization/signing/Smithy HTTP handler throws on connected stall and destroys retries", async t => {
  let requests = 0; let destroyed = 0; let clientDestroyed = 0;
  t.mock.method(https, "request", () => {
    requests++;
    const req: any = new EventEmitter();
    req.socket = { connecting: false, setKeepAlive() {}, setTimeout() {} };
    req.end = () => {}; req.write = () => {}; req.setTimeout = () => {};
    let closed = false;
    req.destroy = () => { if (!closed) { closed = true; destroyed++; req.emit("close"); } };
    return req;
  });
  const destroy = STSClient.prototype.destroy;
  t.mock.method(STSClient.prototype, "destroy", function(this: STSClient) { clientDestroyed++; destroy.call(this); });
  const start = Date.now();
  await assert.rejects(withAwsAuthorization(async deps => deps.identity(await source(), "us-west-2"), {
    source, deadlineMs: 3000, requestTimeoutMs: 25,
  }), (error: any) => error.name === "TimeoutError");
  assert.equal(requests, 2, "SDK retry traversed actual handler twice");
  assert.equal(destroyed, requests); assert.ok(clientDestroyed >= 1);
  assert.ok(Date.now() - start < 3000);
});

test("MF3: total authorization deadline aborts stalled SDK request and never launches command", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fm-deadline-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "child-started");
  let requests = 0; let destroyed = 0;
  t.mock.method(https, "request", () => {
    requests++;
    const req: any = new EventEmitter();
    req.socket = { connecting: false, setKeepAlive() {}, setTimeout() {} };
    req.end = () => {}; req.write = () => {}; req.setTimeout = () => {};
    req.destroy = () => { destroyed++; req.emit("close"); };
    return req;
  });
  const options = { source, readCatalog: () => catalog, audit: () => {}, deadlineMs: 150, requestTimeoutMs: 10000 };
  const start = Date.now();
  await assert.rejects(runAwsTask("app", [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')`], options));
  assert.ok(Date.now() - start < 1500); assert.equal(requests, 1); assert.equal(destroyed, 1);
  assert.equal(fs.existsSync(marker), false);
  // Provider that ignores abort may finish later, but cannot create any STS client or child after deadline.
  await assert.rejects(runAwsTask("app", [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')`], {
    ...options, deadlineMs: 20, source: async () => { await new Promise(r => setTimeout(r, 80)); return source(); },
  }));
  await new Promise(r => setTimeout(r, 100));
  assert.equal(requests, 1); assert.equal(fs.existsSync(marker), false);
});

test("MF3: deadline also bounds stalled response consumption after headers", async t => {
  const { PassThrough } = await import("node:stream");
  let body: InstanceType<typeof PassThrough> | undefined;
  let destroyed = false;
  t.mock.method(https, "request", (_options: unknown, callback: (response: any) => void) => {
    const req: any = new EventEmitter();
    req.socket = { connecting: false, setKeepAlive() {}, setTimeout() {} };
    req.write = () => {}; req.setTimeout = () => {};
    req.end = () => {
      body = new PassThrough();
      Object.assign(body, { statusCode: 200, headers: { "content-type": "text/xml" } });
      callback(body);
    };
    req.destroy = () => { destroyed = true; body?.destroy(); req.emit("close"); };
    return req;
  });
  const start = Date.now();
  await assert.rejects(withAwsAuthorization(async deps => deps.identity(await source(), "us-west-2"), {
    source, deadlineMs: 100, requestTimeoutMs: 10000,
  }));
  assert.ok(Date.now() - start < 1500); assert.equal(destroyed, true); assert.equal(body?.destroyed, true);
});
