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
        self.gateway_state = "active"
        self.manager_base = BASE
        self.manager_fragment = self.tx.base
        self.manager_dropins = []

        def reload_manager():
            self.manager_base = self.tx.base.read_text()
            self.manager_dropins = [path for path in [self.tx.dropin, self.tx.nats_dropin]
                                    if path.exists()]
        self.reload_manager = reload_manager

        def ctl(*args):
            self.events.append(args)
            if args[:1] == ("stop",):
                self.gateway_state = "inactive"
                return ""
            if args[:1] == ("restart",) and args[1:] == (self.tx.gateway,):
                self.gateway_state = "active"
                return ""
            if "DropInPaths" in " ".join(args):
                paths = self.manager_dropins if self.tx.gateway in args else []
                return " ".join(str(p) for p in paths)
            if "FragmentPath" in " ".join(args):
                return str(self.manager_fragment)
            if "ExecStart" in " ".join(args):
                starts = m.re.findall(r"^ExecStart=(.+)$", self.manager_base, m.re.M)
                return starts[0] if starts else ""
            if "WorkingDirectory" in " ".join(args):
                return str(self.home)
            if "NeedDaemonReload" in " ".join(args):
                return "no"
            if "ActiveState" in " ".join(args):
                return self.gateway_state
            if "LoadState" in " ".join(args):
                return "loaded"
            if "SubState" in " ".join(args):
                return "running" if self.gateway_state == "active" else "dead"
            if "MainPID" in " ".join(args):
                return "123" if self.gateway_state == "active" else "0"
            if "ControlPID" in " ".join(args):
                return "0"
            if "ControlGroup" in " ".join(args):
                return "/user.slice/openclaw-worker" if self.gateway_state == "active" else ""
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
                "rpc": {"ok": self.gateway_state == "active"}, "gateway": {"version": self.version},
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
            elif argv[1:] == ["gateway", "stop", "--force"]:
                self.gateway_state = "inactive"
            elif argv[1:] == ["gateway", "restart", "--force"]:
                self.gateway_state = "active"
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

        def operator_action(action, root_binary=None):
            if action == "install-dedicated":
                run([str(self.tx.binary), "gateway", "install", "--force"], self.tx.env, 120)
            elif action == "install-root":
                self.tx.base.write_text(BASE)
                (self.home / ".openclaw/gateway.systemd.env").unlink(missing_ok=True)
            elif action != "restart-target":
                raise AssertionError(action)
            self.gateway_state = "active"
            reload_manager()
        self.operator_action = operator_action
        self.tx.operator_action = operator_action
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

    def test_failed_readiness_preserves_native_image_for_retry(self):
        self.fail_ready = True
        status = self.tx.status
        def unready_after_install(binary):
            value = status(binary)
            if str(self.tx.prefix) in self.tx.base.read_text():
                value["rpc"]["ok"] = False
                value["gateway"].pop("version", None)
            return value
        self.tx.status = unready_after_install
        with self.assertRaisesRegex(RuntimeError, "not ready"):
            self.tx.migrate(self.args)
        installed = self.tx.base.read_bytes()
        self.assertIn(str(self.tx.prefix).encode(), installed)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "native-install-required")
        self.tx.status = status
        self.tx.migrate(self.args)
        self.assertEqual(self.tx.base.read_bytes(), installed)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "complete")

    def test_exact_install_boundary_preserves_foreign_definition_without_install_or_restart(self):
        production_action = m.Migration.operator_action.__get__(self.tx, m.Migration)
        boundary = []
        def foreign_then_refuse(action, root_binary=None):
            self.tx.base.write_text(BASE + "# supported native change\n")
            boundary.append(len(self.events))
            production_action(action, root_binary)
        self.tx.operator_action = foreign_then_refuse
        with self.assertRaisesRegex(RuntimeError, "Operator action required"):
            self.tx.migrate(self.args)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "native-install-required")
        self.assert_no_recovery_service_mutation(boundary[0])
        self.assertFalse(any(event[1:3] == ("gateway", "install") for event in self.events[boundary[0]:]))
        self.assertEqual(self.tx.base.read_text(), BASE + "# supported native change\n")
        with patch.object(m, "restore") as restore_spy:
            retry_count = len(self.events)
            with self.assertRaisesRegex(RuntimeError, "changed"):
                self.tx.migrate(self.args)
            restore_spy.assert_not_called()
        self.assert_no_recovery_service_mutation(retry_count)
        self.assertFalse(any(event[1:3] == ("gateway", "install") for event in self.events[retry_count:]))

    def crash_after_stop(self):
        save = self.tx.save
        interrupted = False
        def crash(data, phase):
            nonlocal interrupted
            save(data, phase)
            if phase == "stopped" and not interrupted:
                interrupted = True
                raise Interrupted()
        self.tx.save = crash
        with self.assertRaises(Interrupted):
            self.tx.migrate(self.args)
        self.tx.save = save
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "stopped")

    def test_crash_after_stop_recovers_from_journaled_inactive_service_image(self):
        self.crash_after_stop()
        self.assertEqual(self.gateway_state, "inactive")
        manager = json.loads(self.tx.journal.read_text())["stopped_manager"]
        self.assertEqual(manager["definition"]["service_identity"], self.tx.gateway)
        self.assertTrue({"FragmentPath", "fragment_file", "ExecStart", "DropInPaths", "dropin_files",
                         "WorkingDirectory", "Environment", "EnvironmentFiles",
                         "environment_file_launch_inputs", "UnsetEnvironment",
                         "NeedDaemonReload", "LoadState"}.issubset(manager["definition"]))
        self.assertEqual(manager["runtime"], {
            "LoadState": "loaded", "ActiveState": "inactive-or-failed",
            "MainPID": "0", "ControlPID": "0", "ControlGroup": "",
        })
        self.tx.migrate(self.args)
        self.assertEqual(self.tx.base.read_text(), BASE)
        self.assertEqual(self.gateway_state, "active")
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "recovered")

    def test_inactive_and_failed_manager_definition_drift_refuse_before_mutation(self):
        self.crash_after_stop()
        for state in ["inactive", "failed"]:
            with self.subTest(state=state):
                self.gateway_state = state
                self.manager_fragment = self.home / "foreign.service"
                self.manager_fragment.write_text(BASE.replace("/usr/bin/openclaw", "/other/openclaw"))
                self.manager_base = BASE.replace("/usr/bin/openclaw", "/other/openclaw")
                event_count = len(self.events)
                with patch.object(m, "restore") as restore_spy:
                    with self.assertRaisesRegex(RuntimeError, "loaded gateway definition changed"):
                        self.tx.migrate(self.args)
                    restore_spy.assert_not_called()
                self.assert_no_recovery_service_mutation(event_count)
                self.manager_fragment = self.tx.base
                self.manager_base = BASE

    def test_offline_nonzero_process_state_refuses_before_mutation(self):
        self.crash_after_stop()
        original = self.tx.ctl
        for prop, value in [("MainPID", "91"), ("ControlPID", "92"),
                            ("ControlGroup", "/user.slice/foreign")]:
            with self.subTest(prop=prop):
                self.gateway_state = "failed"
                self.tx.ctl = lambda *args, prop=prop, value=value: (
                    value if f"--property={prop}" in args else original(*args))
                event_count = len(self.events)
                with patch.object(m, "restore") as restore_spy:
                    with self.assertRaisesRegex(RuntimeError, "process-free"):
                        self.tx.migrate(self.args)
                    restore_spy.assert_not_called()
                self.assert_no_recovery_service_mutation(event_count)
        self.tx.ctl = original

    def test_crash_during_file_mutation_recovers_only_journaled_per_file_images(self):
        atomic_write = m.atomic_write
        interrupted = False
        def crash_mid_image(path, content, home, mode=0o600):
            nonlocal interrupted
            atomic_write(path, content, home, mode)
            if path == self.tx.nats_dropin and not interrupted:
                interrupted = True
                raise Interrupted()
        with patch.object(m, "atomic_write", crash_mid_image):
            with self.assertRaises(Interrupted):
                self.tx.migrate(self.args)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "mutating-files")
        self.assertEqual(self.gateway_state, "inactive")
        self.tx.migrate(self.args)
        self.assertEqual(self.tx.base.read_text(), BASE)
        self.assertFalse(self.tx.dropin.exists())
        self.assertFalse(self.tx.nats_dropin.exists())
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "recovered")

    def test_exact_recovery_restore_gap_preserves_foreign_native_image_and_stops(self):
        atomic_write = m.atomic_write
        interrupted = False
        def crash_mid_image(path, content, home, mode=0o600):
            nonlocal interrupted
            atomic_write(path, content, home, mode)
            if path == self.tx.nats_dropin and not interrupted:
                interrupted = True
                raise Interrupted()
        with patch.object(m, "atomic_write", crash_mid_image):
            with self.assertRaises(Interrupted):
                self.tx.migrate(self.args)
        real_restore = m.restore
        boundary = []
        def foreign_then_restore(image, home):
            self.tx.base.write_text(BASE + "# native owner won recovery race\n")
            boundary.append(len(self.events))
            real_restore(image, home)
        with patch.object(m, "restore", foreign_then_restore):
            with self.assertRaisesRegex(RuntimeError, "Native service image changed"):
                self.tx.migrate(self.args)
        self.assertEqual(self.tx.base.read_text(), BASE + "# native owner won recovery race\n")
        self.assert_no_recovery_service_mutation(boundary[0])
        self.assertFalse(any(event[1:3] == ("gateway", "install") for event in self.events[boundary[0]:]))
        with patch.object(m, "restore") as restore_spy:
            retry_count = len(self.events)
            with self.assertRaisesRegex(RuntimeError, "Native service image changed"):
                self.tx.migrate(self.args)
            restore_spy.assert_not_called()
        self.assert_no_recovery_service_mutation(retry_count)
        self.assertFalse(any(event[1:3] == ("gateway", "install") for event in self.events[retry_count:]))

    def test_exact_rollback_restore_gap_preserves_foreign_native_image_and_stops(self):
        self.tx.migrate(self.args)
        self.args.rollback = True
        real_restore = m.restore
        boundary = []
        foreign = BASE + "# native owner won rollback race\n"
        def foreign_then_restore(image, home):
            self.tx.base.write_text(foreign)
            boundary.append(len(self.events))
            real_restore(image, home)
        with patch.object(m, "restore", foreign_then_restore):
            with self.assertRaisesRegex(RuntimeError, "Native service image changed"):
                self.tx.migrate(self.args)
        self.assertEqual(self.tx.base.read_text(), foreign)
        self.assert_no_recovery_service_mutation(boundary[0])
        self.assertFalse(any(event[1:3] == ("gateway", "install") for event in self.events[boundary[0]:]))
        with patch.object(m, "restore") as restore_spy:
            retry_count = len(self.events)
            with self.assertRaisesRegex(RuntimeError, "Native service image changed"):
                self.tx.migrate(self.args)
            restore_spy.assert_not_called()
        self.assert_no_recovery_service_mutation(retry_count)
        self.assertFalse(any(event[1:3] == ("gateway", "install") for event in self.events[retry_count:]))

    def test_interrupted_rollback_owned_restore_recovers_dedicated_source(self):
        self.tx.migrate(self.args)
        migrated_base = self.tx.base.read_bytes()
        self.args.rollback = True
        real_restore = m.restore
        interrupted = False
        def remove_first_owned_file_then_crash(image, home):
            nonlocal interrupted
            if not interrupted:
                interrupted = True
                first = next(iter(image))
                real_restore({first: image[first]}, home)
                raise Interrupted()
            real_restore(image, home)
        with patch.object(m, "restore", remove_first_owned_file_then_crash):
            with self.assertRaises(Interrupted):
                self.tx.migrate(self.args)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"],
                         "rollback-mutating-owned-files")
        self.assertEqual(self.gateway_state, "inactive")
        self.tx.migrate(self.args)
        self.assertEqual(self.tx.base.read_bytes(), migrated_base)
        self.assertEqual(self.gateway_state, "active")
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "complete")

    def interrupt_forward_verification(self):
        ready = self.tx.ready
        def interrupt(binary, version):
            if str(binary) == str(self.tx.binary):
                raise Interrupted()
            return ready(binary, version)
        self.tx.ready = interrupt
        with self.assertRaises(Interrupted):
            self.tx.migrate(self.args)
        self.tx.ready = ready
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "native-install-required")
        self.assertIn(str(self.tx.prefix), self.tx.base.read_text())

    def interrupt_reverse_activation(self):
        self.tx.migrate(self.args)
        self.args.rollback = True
        self.tx.operator_action = m.Migration.operator_action.__get__(self.tx, m.Migration)
        with self.assertRaisesRegex(RuntimeError, "Operator action required"):
            self.tx.migrate(self.args)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "rollback-native-install-required")
        self.tx.operator_action = self.operator_action
        self.assertIn(str(self.tx.prefix), self.tx.base.read_text())

    def assert_no_recovery_service_mutation(self, event_count):
        recovery_events = self.events[event_count:]
        self.assertFalse(any(event and (event[0] in {"stop", "restart", "daemon-reload"} or
                                       event[1:] in (("gateway", "stop", "--force"),
                                                    ("gateway", "restart", "--force")))
                             for event in recovery_events))

    def test_interrupted_verification_refuses_downgrade_after_native_runtime_advances(self):
        self.interrupt_forward_verification()

        # Model a successful native update after the migration process died.
        self.version = "2026.10.1"
        self.gateway_state = "active"
        self.tx.binary.write_text("advanced runtime")
        before_base = self.tx.base.read_bytes()
        event_count = len(self.events)
        with self.assertRaisesRegex(RuntimeError, "launcher|advanced"):
            self.tx.migrate(self.args)
        self.assert_no_recovery_service_mutation(event_count)
        self.assertEqual(self.tx.base.read_bytes(), before_base)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "native-install-required")

    def test_forward_recovery_refuses_changed_destination_launcher_fingerprint_before_mutation(self):
        self.interrupt_forward_verification()
        launcher_facts = self.tx.launcher_facts
        def drift_root(binary, root=False):
            facts = launcher_facts(binary, root)
            return {**facts, "fingerprint-drift": True} if root else facts
        self.tx.launcher_facts = drift_root
        before_base = self.tx.base.read_bytes()
        event_count = len(self.events)
        with self.assertRaisesRegex(RuntimeError, "launcher"):
            self.tx.migrate(self.args)
        self.assert_no_recovery_service_mutation(event_count)
        self.assertEqual(self.tx.base.read_bytes(), before_base)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "native-install-required")

    def test_forward_recovery_refuses_changed_destination_launcher_version_before_mutation(self):
        self.interrupt_forward_verification()
        self.launcher_versions["/usr/bin/openclaw"] = "2026.9.4"
        before_base = self.tx.base.read_bytes()
        event_count = len(self.events)
        with self.assertRaisesRegex(RuntimeError, "launcher"):
            self.tx.migrate(self.args)
        self.assert_no_recovery_service_mutation(event_count)
        self.assertEqual(self.tx.base.read_bytes(), before_base)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "native-install-required")

    def test_reverse_recovery_refuses_changed_destination_launcher_fingerprint_before_mutation(self):
        self.interrupt_reverse_activation()
        self.tx.binary.write_text("same-version destination drift")
        before_base = self.tx.base.read_bytes()
        event_count = len(self.events)
        with self.assertRaisesRegex(RuntimeError, "launcher"):
            self.tx.migrate(self.args)
        self.assert_no_recovery_service_mutation(event_count)
        self.assertEqual(self.tx.base.read_bytes(), before_base)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "rollback-native-install-required")

    def test_reverse_recovery_refuses_changed_destination_launcher_version_before_mutation(self):
        self.interrupt_reverse_activation()
        self.launcher_versions[str(self.tx.binary)] = "2026.9.4"
        before_base = self.tx.base.read_bytes()
        event_count = len(self.events)
        with self.assertRaisesRegex(RuntimeError, "launcher"):
            self.tx.migrate(self.args)
        self.assert_no_recovery_service_mutation(event_count)
        self.assertEqual(self.tx.base.read_bytes(), before_base)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "rollback-native-install-required")

    def test_rollback_readiness_failure_preserves_operator_installed_root_and_is_retryable(self):
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
        self.assertNotEqual(self.tx.base.read_bytes(), migrated)
        self.assertEqual(self.tx.base.read_text(), BASE)
        self.assertFalse(self.tx.nats_dropin.exists())
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "rollback-native-install-required")
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
        self.assertFalse(any(event[1:] == ("gateway", "stop", "--force") for event in self.events))
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

    def test_pre_stop_race_refuses_before_service_mutation(self):
        save = self.tx.save
        def drift_after_admission(data, phase):
            save(data, phase)
            if phase == "prepared":
                self.tx.base.write_text(BASE + "# concurrent owner\n")
        self.tx.save = drift_after_admission
        with self.assertRaisesRegex(RuntimeError, "service image"):
            self.tx.migrate(self.args)
        self.assertFalse(any(event[1:] == ("gateway", "stop", "--force") for event in self.events))
        self.assertEqual(self.tx.base.read_text(), BASE + "# concurrent owner\n")
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "prepared")

    def test_pre_stop_loaded_manager_drift_refuses_before_service_mutation(self):
        save = self.tx.save
        def drift_loaded_manager(data, phase):
            save(data, phase)
            if phase == "prepared":
                self.manager_fragment = self.home / "foreign.service"
                self.manager_fragment.write_text(BASE.replace("/usr/bin/openclaw", "/other/openclaw"))
                self.manager_base = BASE.replace("/usr/bin/openclaw", "/other/openclaw")
        self.tx.save = drift_loaded_manager
        with self.assertRaisesRegex(RuntimeError, "source manager changed before stop"):
            self.tx.migrate(self.args)
        self.assertFalse(any(event[1:] == ("gateway", "stop", "--force") for event in self.events))
        self.assertEqual(self.tx.base.read_text(), BASE)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "prepared")

    def test_interruption_inside_stop_recovers_from_pre_stop_manager_attestation(self):
        stop = self.tx.stop_gateway
        interrupted = False
        def stop_then_crash(binary):
            nonlocal interrupted
            stop(binary)
            if not interrupted:
                interrupted = True
                raise Interrupted()
        self.tx.stop_gateway = stop_then_crash
        with self.assertRaises(Interrupted):
            self.tx.migrate(self.args)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "prepared")
        self.assertEqual(self.gateway_state, "inactive")
        self.tx.stop_gateway = stop
        self.tx.migrate(self.args)
        self.assertEqual(self.gateway_state, "active")
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "recovered")

    def test_post_mutation_pre_activation_race_refuses_restart_and_recovery_overwrite(self):
        action = self.tx.operator_action
        def replace_after_operator_install(kind, root_binary=None):
            action(kind, root_binary)
            self.tx.binary.write_text("concurrent same-version runtime replacement")
        self.tx.operator_action = replace_after_operator_install
        restart_count = sum(event[1:] == ("gateway", "restart", "--force") for event in self.events)
        with self.assertRaisesRegex(RuntimeError, "launcher"):
            self.tx.migrate(self.args)
        self.assertEqual(sum(event[1:] == ("gateway", "restart", "--force") for event in self.events), restart_count)
        self.assertIn(str(self.tx.prefix), self.tx.base.read_text())
        self.assertEqual(self.tx.binary.read_text(), "concurrent same-version runtime replacement")
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "native-install-required")

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
        save = self.tx.save
        interrupted = False
        def crash_after_stop(data, phase):
            nonlocal interrupted
            save(data, phase)
            if phase == "stopped" and not interrupted:
                interrupted = True
                raise Interrupted()
        self.tx.save = crash_after_stop
        with self.assertRaises(Interrupted):
            self.tx.migrate(self.args)
        self.tx.save = save
        with patch.object(m, "restore", side_effect=RuntimeError("restore failed")):
            with self.assertRaisesRegex(RuntimeError, "restore failed"):
                self.tx.migrate(self.args)
        self.assertEqual(json.loads(self.tx.journal.read_text())["phase"], "recovering-owned-files")


if __name__ == "__main__":
    unittest.main()
