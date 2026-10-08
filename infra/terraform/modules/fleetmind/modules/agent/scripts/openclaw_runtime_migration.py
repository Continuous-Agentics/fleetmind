#!/usr/bin/env python3
"""Same-release ownership transfer, never an updater. Runs only as openclaw.

A private fsynced journal is written before every activation. Interrupted runs
restore their preimage before accepting a new request. No root writes occur in
this program. Runtime state/config/plugins are never snapshotted or rolled back.
"""
import argparse
import base64
import fcntl
import json
import hashlib
import os
from pathlib import Path
import pwd
import re
import shlex
import signal
import stat
import subprocess
import tempfile
import time

VERSION = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")

# Only non-secret inputs that can select the launcher, configuration, runtime
# state, or service identity are persisted in attestations. Values are hashed;
# token/credential variables are intentionally absent and are never retained.
STATE_COMPATIBILITY_ENVIRONMENT = {
    "HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME",
    "OPENCLAW_HOME", "OPENCLAW_CONFIG_PATH", "OPENCLAW_CONFIG_DIR",
    "OPENCLAW_STATE_DIR", "OPENCLAW_PROFILE",
}

LAUNCH_ENVIRONMENT = {
    "HOME", "PATH", "TMPDIR", "TMP", "TEMP", "NODE_PATH", "NODE_OPTIONS",
    "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
    "OPENCLAW_HOME", "OPENCLAW_CONFIG_PATH", "OPENCLAW_CONFIG_DIR",
    "OPENCLAW_STATE_DIR", "OPENCLAW_PROFILE", "OPENCLAW_SYSTEMD_UNIT",
    "OPENCLAW_BIN", "FLEETMIND_OPENCLAW_BIN", "NPM_CONFIG_PREFIX",
    "FLEET_YAML", "OPENCLAW_GATEWAY_PORT",
}


def selected_environment(values):
    """Hash allowlisted launch inputs without retaining any environment value."""
    if isinstance(values, dict):
        items = values.items()
    elif isinstance(values, list):
        items = (item.split("=", 1) for item in values if isinstance(item, str) and "=" in item)
    elif isinstance(values, str):
        items = (item.split("=", 1) for item in shlex.split(values) if "=" in item)
    else:
        items = []
    return {name: hashlib.sha256(str(value).encode()).hexdigest()
            for name, value in items if name in LAUNCH_ENVIRONMENT}


def environment_file_inputs(path):
    """Fingerprint only allowlisted assignments; ignore secret refreshes."""
    selected = {}
    for line in path.read_text().splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        name, value = text.split("=", 1)
        name = name.strip()
        if name in LAUNCH_ENVIRONMENT:
            selected[name] = hashlib.sha256(value.encode()).hexdigest()
    return selected


def safe_path(path, home):
    """Reject links, foreign-owned account paths and writable shared ancestors."""
    path = Path(path)
    if not path.is_absolute() or not path.is_relative_to(home):
        raise RuntimeError("Path is outside runtime home")
    for item in [*reversed(path.parents), path]:
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode):
            raise RuntimeError(f"Symlink layout rejected: {item}")
        owner = os.getuid() if item.is_relative_to(home) else 0
        if info.st_uid != owner or info.st_mode & 0o022:
            raise RuntimeError(f"Unsafe ownership/permissions: {item}")
        if item != path and not stat.S_ISDIR(info.st_mode):
            raise RuntimeError(f"Non-directory ancestor: {item}")
        if item == path and not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise RuntimeError(f"Unexpected file type: {item}")


def atomic_write(path, content, home, mode=0o600):
    safe_path(path, home)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    safe_path(path.parent, home)
    fd, name = tempfile.mkstemp(prefix=".fleetmind-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def snapshot(paths, home):
    result = {}
    for path in paths:
        safe_path(path, home)
        result[str(path)] = None if not path.exists() else {
            "data": base64.b64encode(path.read_bytes()).decode(),
            "mode": stat.S_IMODE(path.stat().st_mode),
        }
    return result


def restore(files, home):
    for name, saved in files.items():
        path = Path(name)
        safe_path(path, home)
        if saved is None:
            path.unlink(missing_ok=True)
            if path.parent.exists():
                fd = os.open(path.parent, os.O_DIRECTORY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
        else:
            atomic_write(path, base64.b64decode(saved["data"]), home, saved["mode"])


def run(args, env, timeout=90):
    # Do not print subprocess/config/secret output on failure.
    proc = subprocess.run(args, env=env, capture_output=True, text=True, timeout=timeout)
    if proc.returncode:
        raise RuntimeError(f"Command failed ({proc.returncode}): {args[0]} {args[1] if len(args) > 1 else ''}; inspect locally")
    return proc.stdout


def exact_version(argv, env):
    output = run([*argv, "--version"], env, 30)
    versions = re.findall(r"(?<![\w.])\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", output)
    if len(versions) != 1:
        raise RuntimeError("Cannot establish exact launcher version")
    return versions[0]


def policy_dropin(base, prefix, binary):
    # Preserve FleetMind's Unit/Service policy, including secret refresh, env,
    # config guard, restart limits, logs. The native installer owns the launcher.
    # Refuse unfamiliar launch overrides rather than guessing their semantics.
    section = ""
    lines = []
    forbidden = {"ExecStartPost", "ExecStop", "ExecStopPost", "RootDirectory", "RootImage"}
    for line in base.splitlines():
        text = line.strip()
        if text.startswith("["):
            section = text
        if section not in ("[Unit]", "[Service]"):
            continue
        key = text.split("=", 1)[0]
        if key in forbidden or text.endswith("\\"):
            raise RuntimeError("Unsupported custom unit; review before migration")
        if key in {"ExecStart", "WorkingDirectory", "Type", "Description"}:
            continue
        lines.append(line)
    if "ExecStartPre=/usr/local/bin/fetch-agent-secrets " not in base or "ConditionPathExists=" not in base:
        raise RuntimeError("Not a recognized FleetMind gateway unit")
    lines.extend(["[Service]", f"Environment=PATH={prefix}/bin:/usr/local/bin:/usr/bin:/bin",
                  f"Environment=NPM_CONFIG_PREFIX={prefix}", f"Environment=FLEETMIND_OPENCLAW_BIN={binary}"])
    return ("\n".join(lines) + "\n").encode()


class Migration:
    def __init__(self, home, agent):
        self.home = home
        self.prefix = home / ".local/share/fleetmind/openclaw-runtime"
        self.binary = self.prefix / "bin/openclaw"
        self.units = home / ".config/systemd/user"
        self.gateway = f"openclaw-{agent}.service"
        self.nats = f"fleetmind-nats-{agent}.service"
        self.base = self.units / self.gateway
        self.dropin = self.units / f"{self.gateway}.d/50-fleetmind.conf"
        self.nats_dropin = self.units / f"{self.nats}.d/50-fleetmind-runtime.conf"
        self.selector = home / ".config/fleetmind/openclaw-runtime.json"
        self.profile = home / ".config/fleetmind/openclaw-runtime.sh"
        self.journal = home / ".config/fleetmind/openclaw-migration.json"
        self.env = {**os.environ, "HOME": str(home), "OPENCLAW_SYSTEMD_UNIT": self.gateway}

    def ctl(self, *args):
        return run(["/usr/bin/systemctl", "--user", *args], self.env)

    def status(self, binary):
        return json.loads(run([str(binary), "gateway", "status", "--json"], self.env, 40))

    def ready(self, binary, version):
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            try:
                status = self.status(binary)
                if status.get("rpc", {}).get("ok") and status.get("gateway", {}).get("version") == version:
                    self.ctl("is-active", "--quiet", self.gateway)
                    return
            except (RuntimeError, subprocess.TimeoutExpired, ValueError):
                pass
            time.sleep(3)
        raise RuntimeError("Gateway did not prove authenticated readiness and expected running version")

    def save(self, data, phase):
        data["phase"] = phase
        atomic_write(self.journal, json.dumps(data).encode(), self.home)

    def activate(self, binary, version, nats_active):
        self.ctl("daemon-reload")
        self.ctl("restart", self.gateway)
        if nats_active:
            self.ctl("restart", self.nats)
            self.ctl("is-active", "--quiet", self.nats)
        self.ready(binary, version)

    def effective_process_environment(self, unit, required=False):
        """Hash allowlisted values from the running process, never its secrets."""
        value = self.ctl("show", unit, "--property=MainPID", "--value").strip()
        try:
            pid = int(value)
        except ValueError:
            pid = 0
        if pid <= 0:
            if required:
                raise RuntimeError("Cannot attest effective gateway process environment")
            return {}
        environ = Path(f"/proc/{pid}/environ")
        try:
            fd = os.open(environ, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode):
                    raise RuntimeError("Unsafe effective process environment source")
                raw = stream.read()
            values = [item.decode("utf-8", "surrogateescape")
                      for item in raw.split(b"\0") if item]
        except (FileNotFoundError, PermissionError):
            raise RuntimeError("Cannot attest effective process environment")
        return selected_environment(values)

    def service_facts(self, binary):
        """Capture disk and manager views; never infer effective state from a base."""
        status = self.status(binary)
        if status.get("service", {}).get("targetRole") != "target":
            raise RuntimeError("Gateway probe does not target the selected service")
        if not status.get("rpc", {}).get("ok"):
            raise RuntimeError("Gateway probe is not authenticated/ready")
        units = {}
        for unit in [self.gateway, self.nats]:
            properties = {}
            for prop in ["FragmentPath", "DropInPaths", "ExecStart", "Environment", "EnvironmentFiles", "WorkingDirectory", "UnsetEnvironment", "NeedDaemonReload", "LoadState"]:
                value = self.ctl("show", unit, f"--property={prop}", "--value").strip()
                # ExecStart's textual structure includes volatile pid/timestamps
                # and exit status. Only its command/ignore-errors fields define
                # the effective launcher; retain those across service restarts.
                if prop == "ExecStart":
                    value = re.sub(r" ; (?:start_time|stop_time|pid|code|status)=[^;}]*", "", value)
                # Never journal raw environment values. Keep only hashed values
                # from the explicit non-secret launch-selection allowlist.
                if prop == "Environment":
                    value = selected_environment(value)
                properties[prop] = value
            if properties["NeedDaemonReload"] == "yes":
                raise RuntimeError("Service manager has pending on-disk changes; reconcile first")
            # Fingerprint every manager-reported drop-in, including global
            # user-manager policy outside the account unit directory.
            properties["dropin_files"] = {}
            for name in shlex.split(properties["DropInPaths"]):
                file = Path(name)
                if file.is_relative_to(self.home):
                    safe_path(file, self.home)
                else:
                    for item in [file, *file.parents]:
                        info = item.lstat()
                        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                            raise RuntimeError("Unsafe manager drop-in path")
                properties["dropin_files"][name] = hashlib.sha256(file.read_bytes()).hexdigest()
            properties["effective_launch_environment"] = self.effective_process_environment(
                unit, required=unit == self.gateway)
            properties["status_resolved_launch_environment"] = (
                selected_environment(status.get("service", {}).get("command", {}).get("environment"))
                if unit == self.gateway else {})
            # EnvironmentFiles contains paths and flags, not their effective
            # contents. Attest only allowlisted launch inputs from each file;
            # expected token/credential refreshes therefore do not invalidate
            # a transaction and no secret-derived material enters the journal.
            properties["environment_file_launch_inputs"] = {}
            names = re.findall(r"(?:^|[\s{;])(?:path=)?-?(/[^\s;}]+)", properties["EnvironmentFiles"])
            for name in dict.fromkeys(names):
                file = Path(name)
                if file.is_relative_to(self.home):
                    safe_path(file, self.home)
                else:
                    for item in [file, *file.parents]:
                        info = item.lstat()
                        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                            raise RuntimeError("Unsafe manager environment-file path")
                properties["environment_file_launch_inputs"][name] = (
                    environment_file_inputs(file) if file.exists() else None)
            units[unit] = properties
        disk_dropins = {}
        for unit in [self.gateway, self.nats]:
            directory = self.units / f"{unit}.d"
            safe_path(directory, self.home)
            if directory.exists():
                disk_dropins.update(snapshot(sorted(directory.glob("*.conf")), self.home))
        return {"units": units, "disk_dropins": disk_dropins,
                "command": status.get("service", {}).get("command", {}).get("programArguments"),
                "running_version": status.get("gateway", {}).get("version")}

    def launcher_facts(self, binary, root=False):
        path = Path(binary)
        resolved = path.resolve(strict=True)
        if not root and not resolved.is_relative_to(self.prefix):
            raise RuntimeError("Dedicated launcher escapes runtime prefix")
        # Include every lexical link and resolved ancestor, not just --version.
        paths = {path, *path.parents, resolved, *resolved.parents}
        facts = {}
        for item in sorted(paths):
            info = item.lstat()
            if root and (info.st_uid != 0 or (not stat.S_ISLNK(info.st_mode) and info.st_mode & 0o022)):
                raise RuntimeError("Root-managed launcher is not root-owned")
            facts[str(item)] = [info.st_dev, info.st_ino, info.st_uid, info.st_mode,
                                info.st_size if not stat.S_ISDIR(info.st_mode) else 0,
                                info.st_mtime_ns if not stat.S_ISDIR(info.st_mode) else 0,
                                os.readlink(item) if stat.S_ISLNK(info.st_mode) else None]
        return {"paths": facts, "resolved": str(resolved),
                "sha256": hashlib.sha256(resolved.read_bytes()).hexdigest(),
                "version": exact_version([str(binary)], self.env)}

    def attest_root(self, binary, version):
        safe_path(self.base, self.home)
        safe_path(self.units / self.nats, self.home)
        facts = self.service_facts(binary)
        if facts["disk_dropins"] or any(unit["DropInPaths"] for unit in facts["units"].values()):
            raise RuntimeError("Existing service drop-ins require operator reconciliation")
        if facts["command"] != [binary, "gateway"] or facts["running_version"] != version:
            raise RuntimeError("Effective running launcher/version changed before migration")
        launcher = self.launcher_facts(binary, root=True)
        if launcher["version"] != version:
            raise RuntimeError("Root launcher version changed before migration")
        return {"files": snapshot([self.base, self.units / self.nats], self.home),
                "service": facts, "launcher": launcher}

    def verify_terminal(self, data, migrated):
        files = data.get("after") if migrated else data.get("before")
        facts = data.get("after_service") if migrated else data.get("before_attestation", {}).get("service")
        launcher = data.get("after_launcher") if migrated else data.get("before_attestation", {}).get("launcher")
        if not files or not facts or not launcher:
            raise RuntimeError("Journal lacks complete attestation; operator reconciliation required")
        if snapshot([Path(p) for p in files], self.home) != files:
            raise RuntimeError("Terminal artifact postimage differs; reconcile before retry")
        binary = self.binary if migrated else data["before_binary"]
        if self.launcher_facts(binary, root=not migrated) != launcher:
            raise RuntimeError("Terminal launcher differs; use native update/recovery workflow")
        self.ready(binary, data["version"])
        if self.service_facts(binary) != facts:
            raise RuntimeError("Terminal effective service differs; reconcile before retry")
        if migrated:
            installed = self.base.read_text()
            if f"OPENCLAW_SYSTEMD_UNIT={self.gateway}" not in installed:
                raise RuntimeError("Native base identity missing")
            command = facts["command"] or []
            if not any(str(arg).startswith(str(self.prefix) + "/") for arg in command):
                raise RuntimeError("Effective launcher is outside dedicated prefix")
            if json.loads(self.selector.read_text()) != {"binary": str(self.binary), "mode": "self-managed"}:
                raise RuntimeError("Runtime selector differs")

    def recover(self, data):
        self.attest_recovery_source(data)
        self.attest_recovery_target(data)
        self.save(data, "recovering")
        # Explicit exceptions propagate: a failed restore stays recoverable,
        # never gets marked successful by shell ERR/errexit context rules.
        self.ctl("stop", self.gateway)
        restore(data["before"], self.home)
        self.activate(data["before_binary"], data["version"], data["nats_active"])
        prior = data.get("prior")
        if prior:
            self.verify_terminal(prior, migrated=True)
        else:
            self.verify_terminal(data, migrated=False)
        if prior:
            self.save(prior, "complete")
        else:
            self.save(data, "recovered")

    def attest_recovery_source(self, data):
        """Refuse recovery unless the currently writing gateway is compatible.

        Recovery itself can be a downgrade, so this check precedes every stop,
        restore, daemon reload, or activation. The authenticated gateway and
        the effective launcher must still be the journal's exact release and,
        for a dedicated launcher, the prepared fingerprint.
        """
        candidates = []
        if self.binary.exists():
            candidates.append(str(self.binary))
        if data.get("before_binary") not in candidates:
            candidates.append(data.get("before_binary"))
        status = None
        for probe in candidates:
            if not probe:
                continue
            try:
                candidate = self.status(probe)
            except (RuntimeError, subprocess.TimeoutExpired, ValueError, OSError):
                continue
            if candidate.get("rpc", {}).get("ok") and candidate.get("service", {}).get("targetRole") == "target":
                status = candidate
                break
        if status is None:
            raise RuntimeError("Recovery refused: authenticated effective gateway cannot be safely established; use native recovery/operator reconciliation")
        if status.get("gateway", {}).get("version") != data.get("version"):
            raise RuntimeError("Recovery refused: effective gateway advanced beyond the journal release; use native recovery/operator reconciliation")
        recorded = data.get("before_attestation", {}).get("service")
        if not recorded and data.get("prior"):
            recorded = data["prior"].get("before_attestation", {}).get("service")
        recorded_environment = (recorded or {}).get("units", {}).get(self.gateway, {}).get(
            "effective_launch_environment")
        if recorded_environment is None:
            raise RuntimeError("Recovery refused: gateway state compatibility was not recorded; use native recovery/operator reconciliation")
        current_environment = self.effective_process_environment(self.gateway, required=True)
        before_state = {name: value for name, value in recorded_environment.items()
                        if name in STATE_COMPATIBILITY_ENVIRONMENT}
        current_state = {name: value for name, value in current_environment.items()
                         if name in STATE_COMPATIBILITY_ENVIRONMENT}
        if current_state != before_state:
            raise RuntimeError("Recovery refused: effective gateway state selection changed; use native recovery/operator reconciliation")
        command = status.get("service", {}).get("command", {}).get("programArguments")
        if not isinstance(command, list):
            raise RuntimeError("Recovery refused: effective launcher cannot be safely established; use native recovery/operator reconciliation")
        before_binary = data.get("before_binary")
        root_binary = data.get("prior", {}).get("before_binary", before_binary)
        if command == [root_binary, "gateway"]:
            current = root_binary
            expected = data.get("before_attestation", {}).get("launcher")
            if not expected and data.get("prior"):
                expected = data["prior"].get("before_attestation", {}).get("launcher")
            facts = self.launcher_facts(current, root=True)
        elif any(isinstance(arg, str) and (arg == str(self.binary) or arg.startswith(str(self.prefix) + "/")) for arg in command):
            current = str(self.binary)
            expected = data.get("prepared_launcher")
            if not expected and data.get("prior"):
                expected = data["prior"].get("after_launcher")
            if not expected:
                raise RuntimeError("Recovery refused: dedicated launcher compatibility was not recorded; use native recovery/operator reconciliation")
            facts = self.launcher_facts(current)
        else:
            raise RuntimeError("Recovery refused: effective launcher is not journal-owned; use native recovery/operator reconciliation")
        if facts.get("version") != data.get("version") or facts != expected:
            raise RuntimeError("Recovery refused: effective launcher advanced or changed; use native recovery/operator reconciliation")

    def attest_recovery_target(self, data):
        """Attest the retained destination before recovery changes any state."""
        files = data.get("before")
        binary = data.get("before_binary")
        version = data.get("version")
        prior = data.get("prior")
        if not isinstance(files, dict) or not binary or not version:
            raise RuntimeError("Recovery refused: destination is not completely recorded; use native recovery/operator reconciliation")
        if prior:
            # A failed reverse transaction returns to the completed dedicated
            # postimage. The rollback snapshot must still be that exact image.
            expected_files = prior.get("after")
            expected_launcher = prior.get("after_launcher")
            root = False
            if not isinstance(expected_files, dict) or files != expected_files:
                raise RuntimeError("Recovery refused: destination service postimage changed; use native recovery/operator reconciliation")
        else:
            # A failed forward transaction returns to the admitted root-managed
            # service preimage. Bind the broader restore set to the independently
            # captured admission snapshot for both service definitions.
            admission = data.get("before_attestation", {})
            expected_files = admission.get("files")
            expected_launcher = admission.get("launcher")
            root = True
            if not isinstance(expected_files, dict) or any(
                    name not in files or files[name] != saved
                    for name, saved in expected_files.items()):
                raise RuntimeError("Recovery refused: destination service postimage changed; use native recovery/operator reconciliation")
        if not expected_launcher:
            raise RuntimeError("Recovery refused: destination launcher compatibility was not recorded; use native recovery/operator reconciliation")
        try:
            facts = self.launcher_facts(binary, root=root)
        except (RuntimeError, subprocess.TimeoutExpired, ValueError, OSError):
            raise RuntimeError("Recovery refused: destination launcher cannot be safely established; use native recovery/operator reconciliation")
        if facts.get("version") != version or facts != expected_launcher:
            raise RuntimeError("Recovery refused: destination launcher changed or is incompatible; use native recovery/operator reconciliation")

    def migrate(self, args):
        for path in [self.prefix, self.units, self.selector, self.journal, self.profile, self.home / ".openclaw"]:
            safe_path(path, self.home)
        self.journal.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock = self.journal.with_suffix(".lock")
        safe_path(lock, self.home)
        with open(lock, "a") as stream:
            os.chmod(lock, 0o600)
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.locked(args)

    def locked(self, args):
        data = json.loads(self.journal.read_text()) if self.journal.exists() else None
        if data and data.get("agent") != self.gateway:
            raise RuntimeError("Migration journal belongs to a different service identity")
        if data and data["phase"] not in {"complete", "recovered", "rolled-back"}:
            self.recover(data)
            raise RuntimeError("Interrupted transaction restored and verified; rerun the requested action")
        if args.rollback:
            if data and data["phase"] == "rolled-back":
                self.verify_terminal(data["prior"], migrated=False)
                return
            if not data or data["phase"] != "complete":
                raise RuntimeError("No completed migration to roll back")
            if exact_version([data["before_binary"]], self.env) != data["version"] or exact_version([str(self.binary)], self.env) != data["version"]:
                raise RuntimeError("Rollback is same-release only; use supported OpenClaw recovery after any update")
            self.verify_terminal(data, migrated=True)
            reverse = {"agent": self.gateway, "before": snapshot([Path(p) for p in data["before"]], self.home),
                       "before_binary": str(self.binary), "version": data["version"],
                       "nats_active": data["nats_active"], "prior": data}
            self.save(reverse, "rollback-prepared")
            try:
                self.ctl("stop", self.gateway)
                restore(data["before"], self.home)
                self.activate(data["before_binary"], data["version"], data["nats_active"])
                self.verify_terminal(data, migrated=False)
                self.save(reverse, "rolled-back")
            except Exception:
                self.recover(reverse)
                raise
            return
        if not args.version or not VERSION.fullmatch(args.version) or args.channel not in {"stable", "extended-stable", "beta", "dev"}:
            raise RuntimeError("Migration requires an exact --version and explicit --channel")
        if data and data["phase"] == "complete":
            if data["version"] != args.version or data["channel"] != args.channel:
                raise RuntimeError("Migration already completed with different parameters; use native updater")
            self.verify_terminal(data, migrated=True)
            return
        config = json.loads((self.home / ".openclaw/openclaw.json").read_text())
        if config.get("update", {}).get("channel") != args.channel:
            raise RuntimeError("Push the selected update.channel before migration")
        safe_path(self.base, self.home)
        base = self.base.read_text()
        # Only canonical root-managed FleetMind units are eligible. Reject any
        # unknown effective override before installing or changing a file.
        for unit in [self.gateway, self.nats]:
            if self.ctl("show", unit, "--property=DropInPaths", "--value").strip():
                raise RuntimeError("Existing service drop-ins require operator reconciliation")
        starts = re.findall(r"^ExecStart=(.+)$", base, re.M)
        if len(starts) != 1:
            raise RuntimeError("Ambiguous gateway launcher")
        argv = shlex.split(starts[0])
        if len(argv) != 2 or argv[1] != "gateway" or argv[0] not in {"/usr/bin/openclaw", "/usr/local/bin/openclaw"}:
            raise RuntimeError("Only canonical root-managed launchers can transfer ownership")
        root_binary = argv[0]
        # Resolve root launcher ancestry and reject any service-user-owned code.
        resolved = Path(root_binary).resolve(strict=True)
        for item in [resolved, *resolved.parents]:
            info = item.stat()
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise RuntimeError("Root-managed launcher is not root-owned")
        status = self.status(root_binary)
        effective = status.get("service", {}).get("command", {}).get("programArguments")
        if effective != argv:
            raise RuntimeError("Effective running launcher differs from canonical base; reconcile before migration")
        if status.get("service", {}).get("targetRole") != "target":
            raise RuntimeError("Gateway probe does not target the selected service")
        if exact_version([root_binary], self.env) != args.version:
            raise RuntimeError("Migration must use the active exact release; upgrade only after ownership transfer")
        self.ready(root_binary, args.version)
        admission = self.attest_root(root_binary, args.version)
        # Bind policy generation to the attested bytes, not the earlier parse
        # performed before readiness/version subprocesses.
        if base.encode() != base64.b64decode(admission["files"][str(self.base)]["data"]):
            raise RuntimeError("Gateway base changed during admission; retry after reconciliation")
        dropin = policy_dropin(base, self.prefix, self.binary)
        # A dedicated prefix may be staged by an interrupted attempt. Never
        # overwrite a different/newer installation, even before activation.
        staging = self.journal.with_name("openclaw-runtime-staging.json")
        safe_path(staging, self.home)
        staged = json.loads(staging.read_text()) if staging.exists() else None
        if staged and staged != {"version": args.version, "prefix": str(self.prefix)}:
            raise RuntimeError("Interrupted staging belongs to a different release")
        if self.binary.exists():
            try:
                installed_version = exact_version([str(self.binary)], self.env)
            except (RuntimeError, OSError):
                if not staged:
                    raise
                installed_version = None
            if installed_version and installed_version != args.version:
                raise RuntimeError("Dedicated runtime differs; refusing overwrite/downgrade")
        elif self.prefix.exists() and any(self.prefix.iterdir()) and not staged:
            raise RuntimeError("Unowned incomplete dedicated runtime: inspect explicitly")
        if not self.binary.exists() or staged:
            atomic_write(staging, json.dumps({"version": args.version, "prefix": str(self.prefix)}).encode(), self.home)
            self.prefix.mkdir(parents=True, exist_ok=True, mode=0o755)
            run(["npm", "install", "-g", f"openclaw@{args.version}"],
                {**self.env, "NPM_CONFIG_PREFIX": str(self.prefix)}, 600)
        if exact_version([str(self.binary)], self.env) != args.version:
            raise RuntimeError("Seed version verification failed")
        staging.unlink(missing_ok=True)
        nats_active = self.ctl("show", self.nats, "--property=ActiveState", "--value").strip() == "active"
        paths = [self.base, self.units / self.nats, Path(str(self.base) + ".bak"), self.dropin, self.nats_dropin,
                 self.selector, self.profile, self.home / ".bashrc", self.home / ".bash_profile",
                 self.home / ".openclaw/gateway.systemd.env"]
        data = {"agent": self.gateway, "before": snapshot(paths, self.home), "before_binary": root_binary,
                "version": args.version, "channel": args.channel, "nats_active": nats_active,
                "before_attestation": admission, "prepared_launcher": self.launcher_facts(self.binary)}
        # Native service locking is an internal JS async/lease protocol, not a
        # supported external flock/CLI interface. Do not counterfeit its lock.
        # Re-attest every admitted fact after potentially long npm staging and
        # immediately before the durable prepared boundary / first stop.
        if self.attest_root(root_binary, args.version) != admission:
            raise RuntimeError("Migration admission changed during staging; retry after reconciliation")
        self.save(data, "prepared")
        try:
            self.ctl("stop", self.gateway)
            atomic_write(self.dropin, dropin, self.home, 0o644)
            atomic_write(self.nats_dropin, (f"[Service]\nEnvironment=PATH={self.prefix}/bin:/usr/local/bin:/usr/bin:/bin\nEnvironment=FLEETMIND_OPENCLAW_BIN={self.binary}\n").encode(), self.home, 0o644)
            atomic_write(self.selector, json.dumps({"binary": str(self.binary), "mode": "self-managed"}).encode(), self.home)
            profile = f"export PATH={self.prefix}/bin:/usr/local/bin:/usr/bin:/bin\nexport FLEETMIND_OPENCLAW_BIN={self.binary}\nexport NPM_CONFIG_PREFIX={self.prefix}\nexport OPENCLAW_SYSTEMD_UNIT={self.gateway}\n"
            profile += 'openclaw() { "$FLEETMIND_OPENCLAW_BIN" "$@"; }\n'
            atomic_write(self.profile, profile.encode(), self.home)
            source = 'source "$HOME/.config/fleetmind/openclaw-runtime.sh"'
            for file in [self.home / ".bashrc", self.home / ".bash_profile"]:
                content = file.read_text() if file.exists() else ""
                if source not in content.splitlines():
                    atomic_write(file, (content + "\n" + source + "\n").encode(), self.home)
            self.save(data, "installing-service")
            run([str(self.binary), "gateway", "install", "--force"],
                {**self.env, "PATH": f"{self.prefix}/bin:/usr/local/bin:/usr/bin:/bin", "NPM_CONFIG_PREFIX": str(self.prefix)}, 120)
            # Identity is required in the native base, not an override stripped
            # by OpenClaw's owned-managed-environment refresh logic.
            installed = self.base.read_text()
            if f"OPENCLAW_SYSTEMD_UNIT={self.gateway}" not in installed:
                raise RuntimeError("Native installer did not persist custom service identity")
            launch = re.findall(r"^ExecStart=(.+)$", installed, re.M)
            if len(launch) != 1 or str(self.prefix) + "/" not in launch[0]:
                raise RuntimeError("Native installer did not select the dedicated runtime")
            self.save(data, "verifying")
            self.activate(self.binary, args.version, nats_active)
            data["after"] = snapshot(paths, self.home)
            data["after_service"] = self.service_facts(self.binary)
            data["after_launcher"] = self.launcher_facts(self.binary)
            self.verify_terminal(data, migrated=True)
            self.save(data, "complete")
        except Exception:
            self.recover(data)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent-id", required=True)
    parser.add_argument("--version")
    parser.add_argument("--channel")
    parser.add_argument("--rollback", action="store_true")
    args = parser.parse_args()
    if os.geteuid() == 0 or pwd.getpwuid(os.getuid()).pw_name != "openclaw":
        raise RuntimeError("Must run unprivileged as openclaw")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", args.agent_id):
        raise RuntimeError("Invalid agent id")
    def interrupted(signum, frame):
        raise RuntimeError("Migration interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    Migration(Path("/home/openclaw"), args.agent_id).migrate(args)
    print("Ownership transaction completed; runtime state and package fallback retained.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Migration stopped: {error}", file=__import__("sys").stderr)
        raise SystemExit(1)
