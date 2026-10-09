import { AWS_RUNTIME_SELECTION } from "../deploy/aws-runtime-user.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDocumentContent } from "../cli/commands/automation-doc.js";
import { FleetSchema } from "../config/schema.js";
import { buildAwsRuntimeUserCommand, DEFAULT_AWS_RUNTIME_USER } from "../deploy/aws-runtime-user.js";

describe("AWS runtime user", () => {
  it("defaults AWS targets to openclaw and permits a compatible override", () => {
    const defaults = FleetSchema.parse({
      fleet: { name: "test-fleet" },
      targets: {
        host: {
          provider: "aws-ssm",
          aws: { region: "us-west-2" },
        },
      },
      agents: { defaults: { target: "host" }, list: [{ id: "worker", name: "Worker" }] },
    });
    const defaultTarget = defaults.targets.host!;
    assert.equal(defaultTarget.provider, "aws-ssm");
    if (defaultTarget.provider === "aws-ssm") {
      assert.equal(defaultTarget.aws.runtime_user, DEFAULT_AWS_RUNTIME_USER);
    }

    const overridden = FleetSchema.parse({
      fleet: { name: "test-fleet" },
      targets: {
        host: {
          provider: "aws-ssm",
          aws: { region: "us-west-2", runtime_user: "ec2-user" },
        },
      },
      agents: { defaults: { target: "host" }, list: [{ id: "worker", name: "Worker" }] },
    });
    const overriddenTarget = overridden.targets.host!;
    assert.equal(overriddenTarget.provider, "aws-ssm");
    if (overriddenTarget.provider === "aws-ssm") {
      assert.equal(overriddenTarget.aws.runtime_user, "ec2-user");
    }
  });

  it("rejects unsafe runtime usernames before they reach an SSM shell", () => {
    assert.throws(() => FleetSchema.parse({
      fleet: { name: "test-fleet" },
      targets: {
        host: {
          provider: "aws-ssm",
          aws: { region: "us-west-2", runtime_user: "openclaw;whoami" },
        },
      },
      agents: { defaults: { target: "host" }, list: [{ id: "worker", name: "Worker" }] },
    }), /safe Linux username/);
  });

  it("sets the runtime user's XDG and DBus environment", () => {
    assert.equal(
      buildAwsRuntimeUserCommand("openclaw", "systemctl --user restart openclaw-worker"),
      `sudo -H -u openclaw env XDG_RUNTIME_DIR=/run/user/$(id -u openclaw) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u openclaw)/bus ${AWS_RUNTIME_SELECTION} systemctl --user restart openclaw-worker`,
    );
  });

  it("defensively rejects an unsafe direct command-builder input", () => {
    assert.throws(
      () => buildAwsRuntimeUserCommand("openclaw;whoami", "true"),
      /Invalid AWS runtime user/,
    );
  });

  it("writes the same user-systemd contract into Automation documents", () => {
    const document = JSON.parse(buildDocumentContent("ec2-user"));
    assert.equal(document.parameters.RuntimeUser.default, "ec2-user");
    assert.equal(document.parameters.RuntimeUser.allowedPattern, "^[a-z_][a-z0-9_-]{0,31}$");
    const commands = document.mainSteps[1].inputs.Parameters.commands.join("\n");
    assert.match(commands, /XDG_RUNTIME_DIR/);
    assert.match(commands, /DBUS_SESSION_BUS_ADDRESS/);
    assert.match(commands, /systemd --user/);
    assert.match(commands, /--user-systemd/);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

it("executes the authoritative SSM selector and refuses missing selected launchers", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fm-ssm-select-"));
  try {
    const bin = path.join(home, "bin");
    const config = path.join(home, ".config/fleetmind");
    fs.mkdirSync(bin);
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(bin, "openclaw"), "#!/bin/sh\necho stale-system\n", { mode: 0o755 });
    const env = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` };
    const invoke = () => execFileSync("/bin/sh", ["-c", `${AWS_RUNTIME_SELECTION} openclaw --version`], { env, encoding: "utf8" });
    assert.equal(invoke().trim(), "stale-system", "legacy hosts without selection retain behavior");
    const selected = path.join(home, "dedicated");
    fs.writeFileSync(selected, "#!/bin/sh\necho selected-runtime\n", { mode: 0o755 });
    fs.writeFileSync(path.join(config, "openclaw-runtime.json"), JSON.stringify({ binary: selected }));
    assert.throws(invoke, "selected hosts require their runtime profile");
    fs.writeFileSync(path.join(config, "openclaw-runtime.sh"), `export FLEETMIND_OPENCLAW_BIN=${selected}\n`);
    assert.equal(invoke().trim(), "selected-runtime");
    fs.unlinkSync(selected);
    assert.throws(invoke, "must not fall back to stale system package");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
