#!/usr/bin/env python3
"""Production migration logic with isolated filesystem and process adapters."""
import sys
sys.dont_write_bytecode = True
import argparse
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "infra/terraform/modules/fleetmind/modules/agent/scripts/openclaw_runtime_migration.py"
spec = importlib.util.spec_from_file_location("migration", SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
BASE = """[Unit]
Description=FleetMind test
ConditionPathExists=/home/openclaw/.openclaw/openclaw.json
StartLimitBurst=5
[Service]
WorkingDirectory=/home/openclaw
Environment=HOME=/home/openclaw
Environment=PATH=/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-/home/openclaw/.config/fleetmind/agent.env
ExecStartPre=/usr/local/bin/fetch-agent-secrets fleet worker file region
ExecStart=/usr/bin/openclaw gateway
Restart=always
[Install]
WantedBy=default.target
"""


class Interrupted(BaseException):
    pass


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT, prefix=".migration-test-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        real_stat = Path.lstat

        def lstat(path):
            # Simulate trusted / and /home ancestors, not /tmp/shared test dirs.
            if path in self.home.parents:
                return SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0, st_dev=0, st_ino=0)
            return real_stat(path)
        self.patch = patch.object(Path, "lstat", lstat)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.tx = m.Migration(self.home, "worker")
        self.tx.units.mkdir(parents=True)
        self.tx.base.write_text(BASE)
        (self.home / ".openclaw").mkdir()
        (self.home / ".openclaw/openclaw.json").write_text(json.dumps({"update": {"channel": "stable"}}))
        (self.home / ".config/fleetmind").mkdir(parents=True)
        self.agent_env = self.home / ".config/fleetmind/agent.env"
        self.agent_env.write_text("SLACK_BOT_TOKEN=secret-one\nFLEETMIND_OPENCLAW_BIN=/usr/bin/openclaw\n")
        self.events = []
        self.fail_ready = False
        self.interrupt_install = False
        self.version = "2026.9.5"

        def ctl(*args):
            self.events.append(args)
            if "DropInPaths" in " ".join(args):
                paths = [self.tx.dropin] if self.tx.gateway in args else [self.tx.nats_dropin]
                return " ".join(str(p) for p in paths if p.exists())
            if "ActiveState" in " ".join(args):
                return "active"
            if "EnvironmentFiles" in " ".join(args):
                return str(self.agent_env)
            if "--property=Environment" in args:
                return f"HOME={self.home} OPENCLAW_GATEWAY_TOKEN=inline-secret"
            return ""
        self.tx.ctl = ctl
        def status(binary):
            environment = {}
            for line in self.agent_env.read_text().splitlines():
                if "=" in line:
                    name, value = line.split("=", 1)
                    environment[name] = value
            return {
                "rpc": {"ok": True}, "gateway": {"version": self.version},
                "service": {"targetRole": "target", "command": {
                    "programArguments": m.shlex.split(m.re.findall(r"^ExecStart=(.+)$", self.tx.base.read_text(), m.re.M)[0]),
                    "environment": environment}}}
        self.tx.status = status
        self.tx.effective_process_environment = lambda unit, required=False: m.selected_environment(
            {line.split("=", 1)[0]: line.split("=", 1)[1]
             for line in self.agent_env.read_text().splitlines() if "=" in line})

        def ready(binary, version):
            self.events.append(("ready", str(binary), version))
            if self.fail_ready and str(binary) == str(self.tx.binary):
                self.fail_ready = False
                raise RuntimeError("not ready")
        self.tx.ready = ready

        def run(argv, env, timeout=90):
            self.events.append(tuple(argv))
            if argv[0] == "npm":
                self.tx.binary.parent.mkdir(parents=True, exist_ok=True)
                self.tx.binary.write_text("fixture")
            elif argv[1:3] == ["gateway", "install"]:
                self.tx.base.write_text(f"[Service]\nExecStart=/usr/bin/node {self.tx.prefix}/lib/node_modules/openclaw/entry gateway\nEnvironment=OPENCLAW_SYSTEMD_UNIT=openclaw-worker.service\n")
                (self.home / ".openclaw/gateway.systemd.env").write_text("native env changed\n")
                if self.interrupt_install:
                    raise Interrupted()
            return ""
        self.launcher_versions = {}
        self.mock_run = patch.object(m, "run", run)
        self.mock_version = patch.object(
            m, "exact_version",
            lambda argv, env: self.launcher_versions.get(str(argv[0]), self.version))
        self.mock_run.start()
        self.mock_version.start()
        self.addCleanup(self.mock_run.stop)
        self.addCleanup(self.mock_version.stop)
        launcher_facts = self.tx.launcher_facts
        self.tx.launcher_facts = lambda binary, root=False: (
            {"version": self.launcher_versions.get(str(binary), self.version), "root": str(binary)}
            if root else launcher_facts(binary, root))
        self.args = argparse.Namespace(agent_id="worker", version="2026.9.5", channel="stable", rollback=False)

    def test_migration_and_idempotent_rollback_restore_both_environments(self):
        self.tx.migrate(self.args)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "complete")
        policy = self.tx.dropin.read_text()
        self.assertIn("ExecStartPre=", policy)
        self.assertIn("EnvironmentFile=", policy)
        self.assertNotIn("ExecStart=", policy)
        self.assertNotIn("WorkingDirectory=", policy)
        self.assertEqual(json.loads(self.tx.selector.read_text())["mode"], "self-managed")
        count = sum(event[:1] == ("npm",) for event in self.events)
        self.tx.migrate(self.args)
        self.assertEqual(sum(event[:1] == ("npm",) for event in self.events), count)
        self.args.rollback = True
        self.tx.migrate(self.args)
        self.assertEqual(self.tx.base.read_text(), BASE)
        for path in [self.tx.dropin, self.tx.nats_dropin, self.tx.selector, self.home / ".openclaw/gateway.systemd.env"]:
            self.assertFalse(path.exists())
        self.assertIn(("restart", self.tx.nats), self.events)
        self.tx.migrate(self.args)  # already rolled back is a verified no-op

    def test_effective_launcher_and_exact_running_release_must_match(self):
        self.version = "2026.10.1"
        with self.assertRaisesRegex(RuntimeError, "active exact release"):
            self.tx.migrate(self.args)
        self.assertFalse(self.tx.prefix.exists())
        self.version = self.args.version
        self.tx.status = lambda binary: {"service": {"command": {"programArguments": ["/other", "gateway"]}}}
        with self.assertRaisesRegex(RuntimeError, "Effective running launcher"):
            self.tx.migrate(self.args)
        self.assertFalse(self.tx.prefix.exists())

    def test_failed_readiness_restores_base_nats_environment_and_selector(self):
        self.fail_ready = True
        with self.assertRaisesRegex(RuntimeError, "not ready"):
            self.tx.migrate(self.args)
        self.assertEqual(self.tx.base.read_text(), BASE)
        self.assertFalse(self.tx.nats_dropin.exists())
        self.assertFalse(self.tx.selector.exists())
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "recovered")
        self.tx.migrate(self.args)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "complete")

    def test_interruption_is_durable_and_next_run_recovers_before_retry(self):
        self.interrupt_install = True
        with self.assertRaises(Interrupted):
            self.tx.migrate(self.args)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "installing-service")
        self.interrupt_install = False
        with self.assertRaisesRegex(RuntimeError, "restored and verified"):
            self.tx.migrate(self.args)
        self.assertEqual(self.tx.base.read_text(), BASE)
        self.tx.migrate(self.args)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "complete")

    def interrupt_forward_verification(self):
        activate = self.tx.activate
        interrupted = False
        def interrupt_verifying(binary, version, nats_active):
            nonlocal interrupted
            if str(binary) == str(self.tx.binary) and not interrupted:
                interrupted = True
                raise Interrupted()
            return activate(binary, version, nats_active)
        self.tx.activate = interrupt_verifying
        try:
            with self.assertRaises(Interrupted):
                self.tx.migrate(self.args)
        finally:
            self.tx.activate = activate
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "verifying")
        self.assertIn(str(self.tx.prefix), self.tx.base.read_text())

    def interrupt_reverse_activation(self):
        self.tx.migrate(self.args)
        self.args.rollback = True
        activate = self.tx.activate
        interrupted = False
        def interrupt_root(binary, version, nats_active):
            nonlocal interrupted
            if str(binary) == "/usr/bin/openclaw" and not interrupted:
                interrupted = True
                raise Interrupted()
            return activate(binary, version, nats_active)
        self.tx.activate = interrupt_root
        try:
            with self.assertRaises(Interrupted):
                self.tx.migrate(self.args)
        finally:
            self.tx.activate = activate
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "rollback-prepared")
        self.assertEqual(self.tx.base.read_text(), BASE)

    def assert_no_recovery_service_mutation(self, event_count):
        recovery_events = self.events[event_count:]
        self.assertFalse(any(event and event[0] in {"stop", "restart", "daemon-reload"}
                             for event in recovery_events))

    def test_interrupted_verification_refuses_downgrade_after_native_runtime_advances(self):
        self.interrupt_forward_verification()

        # Model a successful native update after the migration process died.
        self.version = "2026.10.1"
        self.tx.binary.write_text("advanced runtime")
        before_base = self.tx.base.read_bytes()
        event_count = len(self.events)
        with self.assertRaisesRegex(RuntimeError, "gateway advanced"):
            self.tx.migrate(self.args)
        self.assert_no_recovery_service_mutation(event_count)
        self.assertEqual(self.tx.base.read_bytes(), before_base)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "verifying")

    def test_forward_recovery_refuses_changed_destination_launcher_fingerprint_before_mutation(self):
        self.interrupt_forward_verification()
        launcher_facts = self.tx.launcher_facts
        def drift_root(binary, root=False):
            facts = launcher_facts(binary, root)
            return {**facts, "fingerprint-drift": True} if root else facts
        self.tx.launcher_facts = drift_root
        before_base = self.tx.base.read_bytes()
        event_count = len(self.events)
        with self.assertRaisesRegex(RuntimeError, "destination launcher changed"):
            self.tx.migrate(self.args)
        self.assert_no_recovery_service_mutation(event_count)
        self.assertEqual(self.tx.base.read_bytes(), before_base)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "verifying")

    def test_forward_recovery_refuses_changed_destination_launcher_version_before_mutation(self):
        self.interrupt_forward_verification()
        self.launcher_versions["/usr/bin/openclaw"] = "2026.9.4"
        before_base = self.tx.base.read_bytes()
        event_count = len(self.events)
        with self.assertRaisesRegex(RuntimeError, "destination launcher changed"):
            self.tx.migrate(self.args)
        self.assert_no_recovery_service_mutation(event_count)
        self.assertEqual(self.tx.base.read_bytes(), before_base)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "verifying")

    def test_reverse_recovery_refuses_changed_destination_launcher_fingerprint_before_mutation(self):
        self.interrupt_reverse_activation()
        self.tx.binary.write_text("same-version destination drift")
        before_base = self.tx.base.read_bytes()
        event_count = len(self.events)
        with self.assertRaisesRegex(RuntimeError, "destination launcher changed"):
            self.tx.migrate(self.args)
        self.assert_no_recovery_service_mutation(event_count)
        self.assertEqual(self.tx.base.read_bytes(), before_base)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "rollback-prepared")

    def test_reverse_recovery_refuses_changed_destination_launcher_version_before_mutation(self):
        self.interrupt_reverse_activation()
        self.launcher_versions[str(self.tx.binary)] = "2026.9.4"
        before_base = self.tx.base.read_bytes()
        event_count = len(self.events)
        with self.assertRaisesRegex(RuntimeError, "destination launcher changed"):
            self.tx.migrate(self.args)
        self.assert_no_recovery_service_mutation(event_count)
        self.assertEqual(self.tx.base.read_bytes(), before_base)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "rollback-prepared")

    def test_rollback_failure_restores_self_managed_definition_and_remains_retryable(self):
        self.tx.migrate(self.args)
        migrated = self.tx.base.read_bytes()
        ready = self.tx.ready
        failed = False
        def fail_root(binary, version):
            nonlocal failed
            if str(binary) == "/usr/bin/openclaw" and not failed:
                failed = True
                raise RuntimeError("root readiness failed")
            return ready(binary, version)
        self.tx.ready = fail_root
        self.args.rollback = True
        with self.assertRaisesRegex(RuntimeError, "root readiness failed"):
            self.tx.migrate(self.args)
        self.assertEqual(self.tx.base.read_bytes(), migrated)
        self.assertTrue(self.tx.nats_dropin.exists())
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "complete")
        self.tx.migrate(self.args)
        self.assertEqual(self.tx.base.read_text(), BASE)

    def test_newer_runtime_cannot_be_overwritten_or_rolled_back(self):
        self.tx.migrate(self.args)
        self.version = "2026.10.1"
        self.args.rollback = True
        with self.assertRaisesRegex(RuntimeError, "same-release"):
            self.tx.migrate(self.args)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "complete")

    def test_symlink_foreign_owner_and_shared_write_layout_rejected(self):
        victim = self.home / "victim"
        victim.mkdir()
        link = self.home / "linked"
        link.symlink_to(victim)
        with self.assertRaisesRegex(RuntimeError, "Symlink"):
            m.safe_path(link / "child", self.home)
        victim.chmod(0o777)
        with self.assertRaisesRegex(RuntimeError, "Unsafe ownership"):
            m.safe_path(victim / "child", self.home)
        victim.chmod(0o700)
        with patch.object(Path, "lstat", return_value=SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=99999)):
            with self.assertRaisesRegex(RuntimeError, "Unsafe ownership"):
                m.safe_path(victim, self.home)

    def test_readiness_requires_rpc_and_running_version_not_only_active_unit(self):
        states = iter([
            {"rpc": {"ok": True}, "gateway": {"version": "2026.9.4"}},
            {"rpc": {"ok": True}, "gateway": {"version": "2026.9.5"}},
        ])
        self.tx.status = lambda binary: next(states)
        with patch.object(m.time, "sleep") as sleep:
            m.Migration.ready(self.tx, "/usr/bin/openclaw", "2026.9.5")
            sleep.assert_called_once()
        self.tx.status = lambda binary: {"rpc": {"ok": False}, "gateway": {"version": "2026.9.5"}}
        with patch.object(m.time, "sleep"), patch.object(m.time, "monotonic", side_effect=[0, 1, 122]):
            with self.assertRaisesRegex(RuntimeError, "authenticated readiness"):
                m.Migration.ready(self.tx, "/usr/bin/openclaw", "2026.9.5")

    def test_interrupted_npm_staging_retries_only_its_recorded_exact_release(self):
        run = m.run
        def interrupted(argv, env, timeout=90):
            if argv[0] == "npm":
                self.tx.prefix.mkdir(parents=True, exist_ok=True)
                (self.tx.prefix / "partial").write_text("incomplete")
                raise Interrupted()
            return run(argv, env, timeout)
        with patch.object(m, "run", interrupted):
            with self.assertRaises(Interrupted):
                self.tx.migrate(self.args)
        self.assertEqual(self.tx.base.read_text(), BASE)
        self.assertTrue(self.tx.journal.with_name("openclaw-runtime-staging.json").exists())
        self.tx.migrate(self.args)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "complete")

    def assert_staging_mutation_aborts(self, mutate):
        original_run = m.run
        def run(argv, env, timeout=90):
            result = original_run(argv, env, timeout)
            if argv[0] == "npm":
                mutate()
            return result
        with patch.object(m, "run", run):
            with self.assertRaises(RuntimeError):
                self.tx.migrate(self.args)
        self.assertNotIn(("stop", self.tx.gateway), self.events)
        self.assertFalse(self.tx.journal.exists())

    def test_staging_base_drift_aborts_before_prepared(self):
        self.assert_staging_mutation_aborts(lambda: self.tx.base.write_text(BASE + "# changed\n"))

    def test_staging_launcher_version_drift_aborts_before_prepared(self):
        self.assert_staging_mutation_aborts(lambda: setattr(self, "version", "2026.10.1"))

    def test_staging_effective_command_drift_aborts_before_prepared(self):
        self.assert_staging_mutation_aborts(lambda: setattr(self.tx, "status", lambda binary: {
            "rpc": {"ok": True}, "gateway": {"version": "2026.9.5"},
            "service": {"targetRole": "target", "command": {"programArguments": ["/other", "gateway"]}}}))

    def test_staging_running_gateway_only_drift_aborts_before_prepared(self):
        status = self.tx.status
        def mutate():
            def changed(binary):
                value = status(binary)
                value["gateway"]["version"] = "2026.10.1"
                return value
            self.tx.status = changed
        self.assert_staging_mutation_aborts(mutate)

    def test_staging_same_version_launcher_fingerprint_drift_aborts(self):
        launcher = self.tx.launcher_facts
        def mutate():
            self.tx.launcher_facts = lambda binary, root=False: {**launcher(binary, root), "changed": True}
        self.assert_staging_mutation_aborts(mutate)

    def test_staging_new_unloaded_dropin_aborts_before_prepared(self):
        def mutate():
            directory = self.tx.units / (self.tx.gateway + ".d")
            directory.mkdir()
            (directory / "99-other.conf").write_text("[Service]\nExecStart=/other\n")
        self.assert_staging_mutation_aborts(mutate)

    def test_staging_manager_property_drift_aborts_before_prepared(self):
        ctl = self.tx.ctl
        def mutate():
            self.tx.ctl = lambda *args: "/other/base" if "--property=FragmentPath" in args else ctl(*args)
        self.assert_staging_mutation_aborts(mutate)

    def test_terminal_fingerprints_ignore_only_volatile_execution_metadata(self):
        ctl = self.tx.ctl
        clock = [1]
        def show(*args):
            if "--property=ExecStart" in args:
                return "{ path=/usr/bin/openclaw ; argv[]=/usr/bin/openclaw gateway ; ignore_errors=no ; start_time=" + str(clock[0]) + " ; stop_time=n/a ; pid=" + str(clock[0]) + " ; code=(null) ; status=0/0 }"
            return ctl(*args)
        self.tx.ctl = show
        before = self.tx.service_facts("/usr/bin/openclaw")
        clock[0] = 2
        self.assertEqual(before, self.tx.service_facts("/usr/bin/openclaw"))

    def test_production_process_environment_adapter_hashes_only_allowlisted_inputs(self):
        proc = subprocess.Popen(["/bin/sleep", "30"], env={
            "HOME": str(self.home),
            "FLEETMIND_OPENCLAW_BIN": "/fixture/openclaw",
            "SLACK_BOT_TOKEN": "must-not-be-retained",
        })
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        self.tx.ctl = lambda *args: str(proc.pid) if "--property=MainPID" in args else ""
        facts = m.Migration.effective_process_environment(self.tx, self.tx.gateway, required=True)
        self.assertEqual(set(facts), {"HOME", "FLEETMIND_OPENCLAW_BIN"})
        self.assertNotIn("must-not-be-retained", json.dumps(facts))
        self.assertNotIn("SLACK_BOT_TOKEN", facts)
        proc.terminate()
        proc.wait(timeout=5)

    def test_environment_file_launch_input_drift_is_attested_but_secret_refresh_is_not(self):
        self.tx.migrate(self.args)
        before = self.tx.service_facts(self.tx.binary)
        journal = self.tx.journal.read_text()
        self.assertNotIn("secret-one", journal)
        self.assertNotIn("inline-secret", journal)
        self.assertNotIn("SLACK_BOT_TOKEN", journal)
        self.assertNotIn("OPENCLAW_GATEWAY_TOKEN", journal)

        self.agent_env.write_text("SLACK_BOT_TOKEN=secret-two\nFLEETMIND_OPENCLAW_BIN=/usr/bin/openclaw\n")
        self.assertEqual(before, self.tx.service_facts(self.tx.binary))
        self.tx.migrate(self.args)  # expected credential refresh is a verified no-op

        self.agent_env.write_text(f"SLACK_BOT_TOKEN=secret-three\nFLEETMIND_OPENCLAW_BIN={self.tx.binary}\n")
        self.assertNotEqual(before, self.tx.service_facts(self.tx.binary))
        with self.assertRaisesRegex(RuntimeError, "effective service"):
            self.tx.migrate(self.args)

    def test_same_version_terminal_drift_is_not_a_successful_noop(self):
        self.tx.migrate(self.args)
        for file in [self.tx.base, self.tx.selector, self.tx.dropin, self.tx.nats_dropin,
                     self.tx.profile, self.home / ".openclaw/gateway.systemd.env"]:
            with self.subTest(file=file):
                before = file.read_bytes()
                file.write_bytes(before + b"\n# changed")
                with self.assertRaisesRegex(RuntimeError, "postimage"):
                    self.tx.migrate(self.args)
                file.write_bytes(before)
        original_status = self.tx.status
        self.tx.status = lambda binary: {"rpc": {"ok": True}, "gateway": {"version": self.version}, "service": {"targetRole": "target", "command": {"programArguments": ["/other", "gateway"]}}}
        with self.assertRaisesRegex(RuntimeError, "effective service"):
            self.tx.migrate(self.args)
        self.tx.status = original_status
        extra = self.tx.dropin.parent / "99-extra.conf"
        extra.write_text("[Service]\nEnvironment=EXTRA=true\n")
        with self.assertRaisesRegex(RuntimeError, "effective service"):
            self.tx.migrate(self.args)
        extra.unlink()
        self.args.rollback = True
        self.tx.migrate(self.args)
        self.tx.base.write_text(BASE + "# same version but changed unit\n")
        with self.assertRaisesRegex(RuntimeError, "postimage"):
            self.tx.migrate(self.args)
        self.tx.base.write_text(BASE)
        self.tx.nats_dropin.write_text("unexpected recreated artifact")
        with self.assertRaisesRegex(RuntimeError, "postimage"):
            self.tx.migrate(self.args)

    def test_lock_serializes_and_restore_failure_does_not_claim_success(self):
        self.tx.journal.parent.mkdir(parents=True, exist_ok=True)
        lock = self.tx.journal.with_suffix(".lock")
        with open(lock, "w") as stream:
            m.fcntl.flock(stream, m.fcntl.LOCK_EX)
            with self.assertRaises(BlockingIOError):
                self.tx.migrate(self.args)
        self.interrupt_install = True
        with self.assertRaises(Interrupted):
            self.tx.migrate(self.args)
        with patch.object(m, "restore", side_effect=RuntimeError("restore failed")):
            with self.assertRaisesRegex(RuntimeError, "restore failed"):
                self.tx.migrate(self.args)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "recovering")


if __name__ == "__main__":
    unittest.main()
