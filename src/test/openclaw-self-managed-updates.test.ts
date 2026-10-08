import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetSchema } from "../config/schema.js";
import { normalizeFleet } from "../core/model.js";
import { mergeCanonicalConfigs } from "../runtime/openclaw-config.js";
import {
  renderAgentOpenClawJson,
  renderTerraformVars,
} from "../runtime/renderer.js";

function fleetWith(updates?: {
  enabled?: boolean;
  channel?: "stable" | "extended-stable" | "beta" | "dev";
}) {
  return normalizeFleet(
    FleetSchema.parse({
      fleet: { name: "update-test" },
      targets: {
        worker: {
          provider: "aws-ssm",
          os: "linux",
          service_manager: "systemd",
          aws: { region: "us-west-2" },
        },
      },
      agents: {
        list: [
          {
            id: "worker",
            name: "Worker",
            target: "worker",
            providers: ["anthropic"],
          },
        ],
      },
      ...(updates ? { openclaw: { self_managed_updates: updates } } : {}),
    }),
  );
}

describe("OpenClaw self-managed update policy", () => {
  it("requires an explicit channel when self-managed updates are enabled", () => {
    assert.throws(() => fleetWith({ enabled: true }), /explicit channel/);
  });
  it("keeps root-managed runtime ownership and OpenClaw config unchanged by default", () => {
    const fleet = fleetWith();
    const rendered = renderAgentOpenClawJson(fleet, "worker");
    const tfvars = renderTerraformVars(fleet);

    assert.equal(rendered.update, undefined);
    assert.match(tfvars, /openclaw_runtime_mode\s+= "root-managed"/);
  });

  it("renders one explicit channel into OpenClaw config and Terraform when opted in", () => {
    const fleet = fleetWith({ enabled: true, channel: "extended-stable" });
    const rendered = renderAgentOpenClawJson(fleet, "worker");
    const tfvars = renderTerraformVars(fleet);

    assert.deepEqual(rendered.update, { channel: "extended-stable" });
    assert.match(tfvars, /openclaw_runtime_mode\s+= "self-managed"/);
    assert.equal(Object.hasOwn(rendered, "self_managed_updates"), false);
  });

  it("treats the opted-in update channel as fleet-owned policy", () => {
    const incoming = renderAgentOpenClawJson(
      fleetWith({ enabled: true, channel: "extended-stable" }),
      "worker",
    );
    const live = { ...incoming, update: { channel: "beta" } };
    const merged = mergeCanonicalConfigs(incoming, live, {});

    assert.deepEqual(merged.update, { channel: "extended-stable" });
    const disabled = renderAgentOpenClawJson(fleetWith(), "worker");
    const removed = mergeCanonicalConfigs(disabled, merged, incoming);
    assert.equal(removed.update, undefined);
  });
});

// Exercise the production validator (not an injected ConfigValidator) with
// executable CLI fixtures. No fallback system CLI may run when selection fails.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isSupportedOpenClawVersion, resolveOpenClawBinary, validateOpenClawCandidate,
} from "../runtime/openclaw-config.js";

describe("authoritative runtime validation", () => {
  it("uses a minimum plus capability policy instead of rejecting post-seed releases", () => {
    assert.equal(isSupportedOpenClawVersion("OpenClaw 2026.9.5"), true);
    assert.equal(isSupportedOpenClawVersion("2026.10.1"), true);
    assert.equal(isSupportedOpenClawVersion("2027.1.0-beta.1"), true);
    assert.equal(isSupportedOpenClawVersion("2026.9.4"), false);
    assert.equal(isSupportedOpenClawVersion("garbage"), false);
    for (const invalid of ["2026.9.5-beta.1", "2026.9.5-0", "2026.09.005", "2026.10.1-beta.01", "2026.9.5-", "2026.9.5+", "2026.9.5 2027.1.0"]) {
      assert.equal(isSupportedOpenClawVersion(invalid), false, invalid);
    }
    assert.equal(isSupportedOpenClawVersion("2026.9.5+build.001"), true);
  });

  it("selects the persistent user launcher in sanitized SSM environments and fails closed", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fm-launcher-"));
    const before = { ...process.env };
    try {
      process.env.HOME = home;
      delete process.env.FLEETMIND_OPENCLAW_BIN;
      const directory = path.join(home, ".config/fleetmind");
      fs.mkdirSync(directory, { recursive: true });
      const selected = path.join(home, "selected-openclaw");
      const trace = path.join(home, "calls");
      const candidate = path.join(home, "candidate.json");
      fs.writeFileSync(candidate, "{}");
      fs.writeFileSync(path.join(directory, "openclaw-runtime.json"), JSON.stringify({ binary: selected }));
      const installFixture = (version: string, validateExit: number) => fs.writeFileSync(selected,
        `#!/bin/sh\necho "$*" >> '${trace}'\nif [ "$1" = '--version' ]; then echo '${version}'; exit 0; fi\n[ "$OPENCLAW_CONFIG_READONLY" = 1 ] || exit 50\n[ "$1 $2 $3" = 'config validate --json' ] || exit 51\nexit ${validateExit}\n`, { mode: 0o755 });
      installFixture("2026.10.2", 0);
      assert.equal(resolveOpenClawBinary(), selected);
      validateOpenClawCandidate(candidate);
      assert.match(fs.readFileSync(trace, "utf8"), /config validate --json/);
      installFixture("2026.10.2", 1);
      assert.throws(() => validateOpenClawCandidate(candidate), /validation failed/);
      for (const version of ["2026.9.4", "2026.9.5-beta.1", "2026.9.5-0", "2026.09.005"]) {
        installFixture(version, 0);
        fs.writeFileSync(trace, "");
        assert.throws(() => validateOpenClawCandidate(candidate), /validation failed/);
        assert.equal(fs.readFileSync(trace, "utf8"), "--version\n", "invalid minimum must fail before capability probe");
      }
      fs.unlinkSync(selected);
      assert.throws(() => resolveOpenClawBinary());
      assert.throws(() => validateOpenClawCandidate(candidate), /validation failed/);
      process.env.FLEETMIND_OPENCLAW_BIN = "relative/openclaw";
      assert.throws(() => resolveOpenClawBinary(), /absolute path/);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
      Object.assign(process.env, before);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

import { ensureSelfManagedGatewayInstalled } from "../deploy/service.js";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

describe("native self-managed service ownership", () => {
  it("installs a fresh base only after first config publication, never on later pushes", { skip: process.getuid?.() === 0 }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fm-first-push-"));
    const before = { ...process.env };
    try {
      process.env.HOME = home;
      delete process.env.FLEETMIND_OPENCLAW_BIN;
      const prefix = path.join(home, ".local/share/fleetmind/openclaw-runtime");
      const bin = path.join(prefix, "bin/openclaw");
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      const base = path.join(home, ".config/systemd/user/openclaw-worker.service");
      fs.mkdirSync(`${base}.d`, { recursive: true });
      fs.mkdirSync(path.join(home, ".config/fleetmind"), { recursive: true });
      fs.writeFileSync(path.join(home, ".config/fleetmind/openclaw-runtime.json"), JSON.stringify({ binary: bin, mode: "self-managed" }));
      fs.writeFileSync(`${base}.d/50-fleetmind.conf`, "[Service]\nEnvironmentFile=-fixture\n");
      fs.writeFileSync(bin, `#!/bin/sh\n[ "$*" = 'gateway install --force' ] || exit 42\n[ "$NPM_CONFIG_PREFIX" = '${prefix}' ] || exit 43\nprintf '[Service]\\nExecStart=${bin} gateway\\nEnvironment=OPENCLAW_SYSTEMD_UNIT=%s\\n' "$OPENCLAW_SYSTEMD_UNIT" > '${base}'\necho installed >> '${home}/calls'\n`, { mode: 0o755 });
      assert.throws(() => ensureSelfManagedGatewayInstalled("worker"), /published config/);
      assert.equal(fs.existsSync(base), false);
      fs.mkdirSync(path.join(home, ".openclaw"));
      fs.writeFileSync(path.join(home, ".openclaw/openclaw.json"), "{}");
      ensureSelfManagedGatewayInstalled("worker");
      ensureSelfManagedGatewayInstalled("worker");
      // A later native update may replace both launcher contents and base unit.
      // The completed activation receipt prevents FleetMind from reinstalling it.
      fs.writeFileSync(base, `[Service]\nExecStart=/usr/bin/node ${prefix}/lib/node_modules/openclaw/new-entry.mjs gateway\nEnvironment=OPENCLAW_SYSTEMD_UNIT=openclaw-worker.service\n`);
      fs.writeFileSync(bin, "#!/bin/sh\necho unexpected-reinstall >> '" + home + "/calls'\nexit 99\n", { mode: 0o755 });
      ensureSelfManagedGatewayInstalled("worker");
      assert.equal(fs.readFileSync(path.join(home, "calls"), "utf8"), "installed\n");
      assert.match(fs.readFileSync(base, "utf8"), /OPENCLAW_SYSTEMD_UNIT=openclaw-worker.service/);
      assert.equal(fs.readFileSync(`${base}.d/50-fleetmind.conf`, "utf8"), "[Service]\nEnvironmentFile=-fixture\n");
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
      Object.assign(process.env, before);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("adopts a healthy migrated or later native runtime without reinstalling it", { skip: process.getuid?.() === 0 }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fm-healthy-native-"));
    const before = { ...process.env };
    try {
      process.env.HOME = home;
      delete process.env.FLEETMIND_OPENCLAW_BIN;
      const prefix = path.join(home, ".local/share/fleetmind/openclaw-runtime");
      const binary = path.join(prefix, "bin/openclaw");
      const unit = "openclaw-worker.service";
      const base = path.join(home, ".config/systemd/user", unit);
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.mkdirSync(path.dirname(base), { recursive: true });
      fs.mkdirSync(path.join(home, ".config/fleetmind"), { recursive: true });
      fs.writeFileSync(path.join(home, ".config/fleetmind/openclaw-runtime.json"), JSON.stringify({ binary, mode: "self-managed" }));
      fs.writeFileSync(base, `[Service]\nExecStart=/usr/bin/node ${prefix}/lib/node_modules/openclaw/advanced.mjs gateway\nEnvironment=OPENCLAW_SYSTEMD_UNIT=${unit}\n`);
      fs.writeFileSync(binary, `#!/bin/sh\necho reinstall >> '${home}/calls'\nexit 99\n`, { mode: 0o755 });
      const tools = path.join(home, "tools");
      fs.mkdirSync(tools);
      fs.writeFileSync(path.join(tools, "systemctl"), `#!/bin/sh\ncase "$*" in\n  *property=FragmentPath*) printf '%s\\n' '${base}' ;;\n  *property=LoadState*) echo loaded ;;\n  *property=UnitFileState*) echo enabled ;;\n  *property=NeedDaemonReload*) echo no ;;\n  *property=ActiveState*) echo active ;;\n  *property=ExecStart*) echo '${prefix}/lib/node_modules/openclaw/advanced.mjs gateway' ;;\n  *) exit 3 ;;\nesac\n`, { mode: 0o755 });
      process.env.PATH = `${tools}:${before.PATH}`;

      ensureSelfManagedGatewayInstalled("worker");
      assert.equal(fs.existsSync(path.join(home, "calls")), false);
      assert.equal(fs.existsSync(path.join(home, ".config/fleetmind/openclaw-native-service-worker.json")), true);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
      Object.assign(process.env, before);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves custom identity through installed OpenClaw native base rendering and refresh environment", { skip: process.env.FLEETMIND_OPENCLAW_CONTRACT !== "1" }, async () => {
    const packageRoot = process.env.FLEETMIND_OPENCLAW_PACKAGE || path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "openclaw");
    const dist = path.join(packageRoot, "dist");
    // Resolve bundled export names from the installed package, not copied
    // reimplementations of its renderer or update environment stripping logic.
    async function native(modulePrefix: string, symbol: string): Promise<any> {
      const file = fs.readdirSync(dist).find((name) => name.startsWith(modulePrefix + "-") && name.endsWith(".mjs"));
      assert.ok(file, `missing native module ${modulePrefix}`);
      const source = fs.readFileSync(path.join(dist, file), "utf8");
      const alias = new RegExp(`\\b${symbol} as (\\w+)`).exec(source)?.[1];
      assert.ok(alias, `missing native export ${symbol}`);
      return (await import(pathToFileURL(path.join(dist, file)).href))[alias];
    }
    const buildEnv = await native("service-env", "buildServiceEnvironment");
    const buildUnit = await native("systemd-unit", "buildSystemdUnit");
    const refreshEnv = await native("update-command-service-env", "resolveOwnedManagedUpdateEnv");
    const stripOverrides = await native("service-types", "resolveManagedGatewayServiceProcessEnv");
    const env = { HOME: "/fixture/home", OPENCLAW_SYSTEMD_UNIT: "openclaw-worker.service" };
    const managed = buildEnv({ env, port: 18789, platform: "linux", runtime: "node" });
    const effective = { ...managed, NPM_CONFIG_PREFIX: "/fixture/runtime", FLEETMIND_OPENCLAW_BIN: "/fixture/runtime/bin/openclaw" };
    const stripped = stripOverrides({ environment: effective, managedDefinition: { environment: managed }, managedOverrides: { environment: { keys: ["NPM_CONFIG_PREFIX", "FLEETMIND_OPENCLAW_BIN"] } } }, effective);
    const refreshed = refreshEnv({ processEnv: stripped, serviceEnv: effective, serviceDefinitionEnv: managed });
    assert.equal(refreshed.OPENCLAW_SYSTEMD_UNIT, "openclaw-worker.service");
    for (const entry of ["/fixture/runtime/old-entry.mjs", "/fixture/runtime/new-entry.mjs"]) {
      const base = buildUnit({ environment: buildEnv({ env: refreshed, port: 18789, platform: "linux", runtime: "node" }), programArguments: ["/usr/bin/node", entry, "gateway"] });
      assert.match(base, /OPENCLAW_SYSTEMD_UNIT=openclaw-worker.service/);
      assert.match(base, /OPENCLAW_SERVICE_MARKER=openclaw/);
      assert.ok(base.includes(entry));
      assert.equal(base.includes("fetch-agent-secrets"), false, "FleetMind hooks belong in the durable drop-in, never the replaceable base");
    }
    const prefixLayout = await native("update-global", "resolveNpmGlobalPrefixLayoutFromGlobalRoot");
    const installArgs = await native("update-global", "globalInstallArgs");
    const prefix = "/fixture/home/.local/share/fleetmind/openclaw-runtime";
    const layout = prefixLayout(`${prefix}/lib/node_modules`);
    assert.equal(layout.prefix, prefix);
    const update = installArgs("npm", "openclaw@2026.10.1", `${prefix}/lib/node_modules/openclaw`, layout.prefix);
    assert.equal(update[update.indexOf("--prefix") + 1], prefix, "native npm update must retain the dedicated prefix");
    // Adversarial proof: identity only in a drop-in IS stripped by this native
    // implementation. FleetMind must not regress to its original design.
    const broken = refreshEnv({ processEnv: env, serviceEnv: env, serviceDefinitionEnv: {} });
    assert.equal(broken.OPENCLAW_SYSTEMD_UNIT, undefined);
  });
});

import { runPullSelf, type ManifestFile, type DeployManifest } from "../cli/commands/pull-self.js";
import { createHash } from "node:crypto";
import { UserSystemdServiceManager } from "../deploy/service.js";

describe("pull-self native installation across no-change retries", () => {
  for (const failFirst of [false, true]) {
    it(failFirst ? "retries identical artifacts after failed first native install" : "installs on identical restart after apply without restart", { skip: process.getuid?.() === 0 }, async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "fm-pull-native-"));
      const before = { ...process.env };
      try {
        process.env.HOME = home;
        delete process.env.FLEETMIND_OPENCLAW_BIN;
        const prefix = path.join(home, ".local/share/fleetmind/openclaw-runtime");
        const binary = path.join(prefix, "bin/openclaw");
        const base = path.join(home, ".config/systemd/user/openclaw-worker.service");
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.mkdirSync(`${base}.d`, { recursive: true });
        fs.mkdirSync(path.join(home, ".config/fleetmind"), { recursive: true });
        fs.mkdirSync(path.join(home, "tools"));
        fs.writeFileSync(path.join(home, "tools/systemctl"), `#!/bin/sh\necho "$*" >> '${home}/ctl'\n`, { mode: 0o755 });
        process.env.PATH = `${home}/tools:${before.PATH}`;
        fs.writeFileSync(path.join(home, ".config/fleetmind/openclaw-runtime.json"), JSON.stringify({ mode: "self-managed", binary }));
        fs.writeFileSync(`${base}.d/50-fleetmind.conf`, "[Service]\n");
        fs.writeFileSync(binary, `#!/bin/sh\n[ "$*" = 'gateway install --force' ] || exit 41\necho install >> '${home}/calls'\nprintf '[Service]\\nExecStart=${binary} gateway\\nEnvironment=OPENCLAW_SYSTEMD_UNIT=%s\\n' "$OPENCLAW_SYSTEMD_UNIT" > '${base}'\n# Model native publication succeeding before daemon-reload/enable/restart fails.\nif [ -e '${home}/fail' ]; then rm '${home}/fail'; exit 42; fi\n`, { mode: 0o755 });
        if (failFirst) fs.writeFileSync(path.join(home, "fail"), "");
        const staging = path.join(home, "incoming");
        fs.mkdirSync(staging);
        fs.writeFileSync(path.join(staging, "SOUL.md"), "fixture");
        const tar = execFileSync("tar", ["czf", "-", "-C", staging, "."]);
        const files: ManifestFile[] = [{ path: "SOUL.md", size: 7, mode: 644, sha256: "new" }];
        const manifest = { files, tarball: { sha256: createHash("sha256").update(tar).digest("hex") } } as DeployManifest;
        let current: ManifestFile[] = [];
        let applies = 0;
        const manager = new UserSystemdServiceManager();
        const deps = {
          downloadFromS3: async (_bucket: string, key: string) => key.endsWith(".manifest.json") ? Buffer.from(JSON.stringify(manifest)) : tar,
          computeCurrentManifest: () => current,
          applyChanges: () => {
            applies++;
            fs.mkdirSync(path.join(home, ".openclaw"), { recursive: true });
            fs.writeFileSync(path.join(home, ".openclaw/openclaw.json"), "{}");
            current = files;
          },
          restartGateway: () => manager.restartGateway("worker"),
        };
        const opts = { region: "us-west-2", dryRun: false, apply: true, restart: failFirst, force: false, showDiffs: false, agentEnvOverride: { agentId: "worker", fleetName: "test-fleet" } };
        if (failFirst) await assert.rejects(runPullSelf(opts, deps));
        else await runPullSelf(opts, deps);
        assert.equal(fs.existsSync(base), failFirst, "failed native activation may leave a valid partial base");
        // Dry runs and previews must never activate, even if --restart is set.
        await runPullSelf({ ...opts, restart: true, dryRun: true }, deps);
        await runPullSelf({ ...opts, restart: true, apply: false }, deps);
        assert.equal(fs.existsSync(base), failFirst, "previews must not repair a partial native activation");
        await runPullSelf({ ...opts, restart: true }, deps);
        assert.match(fs.readFileSync(base, "utf8"), /OPENCLAW_SYSTEMD_UNIT=openclaw-worker.service/);
        assert.match(fs.readFileSync(path.join(home, "ctl"), "utf8"), /--user restart openclaw-worker/);
        assert.equal(applies, 1);
        assert.equal(fs.readFileSync(path.join(home, "calls"), "utf8"), failFirst ? "install\ninstall\n" : "install\n");
      } finally {
        for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
        Object.assign(process.env, before);
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
});
