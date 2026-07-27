/**
 * Tests for ServiceManager selection + conventions. The restart methods shell
 * out (systemctl / launchctl), so these cover the parts that are pure: which
 * adapter a kind/provider maps to, the launchd label convention the install
 * step must match, and that the no-op manager never throws.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  serviceManagerFor,
  defaultServiceManagerKind,
  SystemdServiceManager,
  UserSystemdServiceManager,
  LaunchdServiceManager,
  NoneServiceManager,
} from "../deploy/service.js";

describe("serviceManagerFor", () => {
  it("maps each kind to its adapter", () => {
    assert.ok(serviceManagerFor("systemd") instanceof SystemdServiceManager);
    assert.ok(serviceManagerFor("systemd", true) instanceof UserSystemdServiceManager);
    assert.ok(serviceManagerFor("launchd") instanceof LaunchdServiceManager);
    assert.ok(serviceManagerFor("none") instanceof NoneServiceManager);
  });
});

describe("defaultServiceManagerKind", () => {
  it("maps providers to sensible defaults", () => {
    assert.equal(defaultServiceManagerKind("aws-ssm"), "systemd");
    assert.equal(defaultServiceManagerKind("ssh"), "systemd");
    assert.equal(defaultServiceManagerKind("local"), "none");
  });
});

describe("LaunchdServiceManager labels", () => {
  it("uses a stable reverse-DNS label convention (the install step must match)", () => {
    assert.equal(LaunchdServiceManager.gatewayLabel("conductor"), "io.fleetmind.openclaw.conductor");
    assert.equal(LaunchdServiceManager.natsLabel("conductor"), "io.fleetmind.nats.conductor");
  });
});

describe("NoneServiceManager", () => {
  it("restarts are no-ops and never throw", () => {
    const sm = new NoneServiceManager();
    assert.doesNotThrow(() => sm.restartGateway("conductor"));
    assert.doesNotThrow(() => sm.restartNatsSubscriber("conductor"));
  });
});
