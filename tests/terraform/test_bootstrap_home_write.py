#!/usr/bin/env python3
"""Execute the exact bootstrap no-follow helper, without touching host services."""
import importlib.util
import io
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / 'infra/terraform/modules/fleetmind/modules/agent/user_data/agent_bootstrap.sh.tpl'
SOURCE = TEMPLATE.read_text().split("<< 'HOME_WRITE_EOF'\n", 1)[1].split('\nHOME_WRITE_EOF', 1)[0]
helper = {}
exec(compile(SOURCE, str(TEMPLATE), 'exec'), helper)


class HomeWriteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        # The production policy intentionally rejects /tmp and user-owned
        # ancestors of /home. Simulate trusted ancestry, retain real descriptors,
        # O_NOFOLLOW, atomic rename and runtime-home ownership checks.
        real = os.fstat
        ancestors = {(p.stat().st_dev, p.stat().st_ino) for p in self.home.parents}
        def fstat(fd):
            info = real(fd)
            if (info.st_dev, info.st_ino) in ancestors:
                return SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o755)
            return info
        guard = patch.object(os, 'fstat', fstat)
        guard.start()
        self.addCleanup(guard.stop)

    def call(self, action, file, content=b'fixture\n'):
        with patch.object(sys, 'argv', ['helper', str(self.home), action, str(file)]), patch.object(sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(content))):
            helper['main']()

    def test_atomic_write_append_remove_and_private_directories(self):
        target = self.home / '.config/systemd/user/unit.d/50-fleetmind.conf'
        self.call('write', target)
        self.assertEqual(target.read_bytes(), b'fixture\n')
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
        self.call('append', target, b'line\n')
        self.call('append', target, b'line\n')
        self.assertEqual(target.read_bytes(), b'fixture\nline\n')
        self.call('remove', target)
        self.assertFalse(target.exists())
        self.call('mkdir', self.home / '.openclaw/workspace')
        self.assertEqual(stat.S_IMODE((self.home / '.openclaw/workspace').stat().st_mode), 0o700)

    def test_append_ignores_commented_substrings_and_keeps_exactly_one_active_line(self):
        target = self.home / '.bashrc'
        source = b'source "$HOME/.config/fleetmind/openclaw-aliases.sh"\n'
        target.write_bytes(b'# source "$HOME/.config/fleetmind/openclaw-aliases.sh"\nkeep=this source text\n' + source + source)
        self.call('append', target, source)
        lines = target.read_bytes().splitlines()
        self.assertEqual(lines.count(source.rstrip()), 1)
        self.assertIn(b'# source "$HOME/.config/fleetmind/openclaw-aliases.sh"', lines)
        self.assertIn(b'keep=this source text', lines)

        target.write_bytes(b'# source "$HOME/.config/fleetmind/openclaw-aliases.sh"\n')
        self.call('append', target, source)
        self.assertEqual(target.read_bytes(), b'# source "$HOME/.config/fleetmind/openclaw-aliases.sh"\n' + source)

    def test_each_bootstrap_destination_rejects_symlink_and_hardlink(self):
        victim = self.home / 'victim'
        victim.write_text('untouched')
        for name in ['.bashrc', '.bash_profile', '.config/fleetmind/openclaw-aliases.sh',
                     '.config/fleetmind/openclaw-runtime.json', '.config/fleetmind/openclaw-runtime.sh',
                     '.config/fleetmind/agent.env', '.config/systemd/user/nats.path',
                     '.config/systemd/user/nats.service', '.config/systemd/user/openclaw.service',
                     '.config/systemd/user/openclaw.service.d/50-fleetmind.conf', '.openclaw/openclaw.json']:
            target = self.home / name
            target.parent.mkdir(parents=True, exist_ok=True)
            for hard in [False, True]:
                if hard:
                    os.link(victim, target)
                else:
                    target.symlink_to(victim)
                for action in ['write', 'append', 'remove']:
                    with self.assertRaises((OSError, RuntimeError)):
                        self.call(action, target)
                target.unlink()
                self.assertEqual(victim.read_text(), 'untouched')

    def test_ancestor_swap_never_redirects_pinned_directory_write(self):
        parent = self.home / 'parent'
        parent.mkdir()
        elsewhere = self.home / 'elsewhere'
        elsewhere.mkdir()
        held = self.home / 'held'
        original = os.open
        swapped = False
        def race(name, flags, *args, **kwargs):
            nonlocal swapped
            fd = original(name, flags, *args, **kwargs)
            if name == 'parent' and flags & os.O_DIRECTORY and not swapped:
                swapped = True
                parent.rename(held)
                parent.symlink_to(elsewhere, target_is_directory=True)
            return fd
        with patch.object(os, 'open', race):
            self.call('write', parent / 'file')
        self.assertFalse((elsewhere / 'file').exists())
        self.assertEqual((held / 'file').read_bytes(), b'fixture\n')

    def test_foreign_owned_destination_is_rejected(self):
        target = self.home / 'file'
        target.write_text('original')
        inode = target.stat().st_ino
        real = os.fstat
        def foreign(fd):
            info = real(fd)
            if getattr(info, 'st_ino', None) == inode:
                return SimpleNamespace(st_uid=os.getuid() + 1, st_mode=info.st_mode)
            return info
        with patch.object(os, 'fstat', foreign):
            with self.assertRaisesRegex(RuntimeError, 'ownership'):
                self.call('write', target)
        self.assertEqual(target.read_text(), 'original')

    def test_unsafe_ancestors_destinations_and_special_files_fail_closed(self):
        parent = self.home / 'parent'
        parent.symlink_to(self.home, target_is_directory=True)
        with self.assertRaises(OSError):
            self.call('write', parent / 'file')
        parent.unlink()
        parent.mkdir(mode=0o777)
        parent.chmod(0o777)
        with self.assertRaises(RuntimeError):
            self.call('write', parent / 'file')
        parent.chmod(0o700)
        fifo = parent / 'fifo'
        os.mkfifo(fifo)
        with self.assertRaises(RuntimeError):
            self.call('write', fifo)
        with self.assertRaises(RuntimeError):
            self.call('write', self.home / '../escape')
        with patch.object(os, 'geteuid', return_value=0):
            with self.assertRaisesRegex(RuntimeError, 'unprivileged'):
                self.call('write', self.home / 'file')


if __name__ == '__main__':
    unittest.main()
