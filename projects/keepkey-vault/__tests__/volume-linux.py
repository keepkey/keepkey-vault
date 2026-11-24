"""Model UDisks2 object topology and check calls on disposable regular files."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('linux_volume', Path(__file__).resolve().parents[1] / 'src/bun/volume-linux.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class Bus:
    LOOP = '/blocks/loop7'
    CLEAR = '/blocks/clear'

    def __init__(self, path):
        self.path = path
        self.state = {}
        self.calls = []
        self.fail_mount = False
        self.fail_unmount = False

    def objects(self):
        return self.state

    def setup_loop(self, fd):
        assert os.path.samestat(os.stat(self.path), os.fstat(fd))
        self.state[self.LOOP] = {backend.LOOP: {'BackingFile': os.fsencode(self.path) + b'\0', 'SetupByUID': os.getuid()}}
        if os.pread(fd, 8, 0) == backend.MAGIC:
            self.state[self.LOOP][backend.ENCRYPTED] = {'CleartextDevice': '/'}
        return self.LOOP

    def unlock(self):
        self.state[self.LOOP][backend.ENCRYPTED] = {'CleartextDevice': self.CLEAR}
        self.state[self.CLEAR] = {backend.BLOCK: {'CryptoBackingDevice': self.LOOP, 'IdType': 'ext4'},
                                  backend.FS: {'MountPoints': []}}
        return self.CLEAR

    def call(self, target, interface, method, *args):
        self.calls.append(method)
        if method == 'Format':
            fmt, options = args
            assert target == self.LOOP and fmt == 'ext4' and options['encrypt.type'] == 'luks2'
            assert options['take-ownership'] and options['encrypt.passphrase'] == 'fixture'
            with open(self.path, 'r+b') as payload:
                payload.write(backend.MAGIC)
            self.unlock()
        elif method == 'Unlock':
            return self.unlock()
        elif method == 'Mount':
            if self.fail_mount:
                raise backend.VolumeError('mount')
            self.state[self.CLEAR][backend.FS]['MountPoints'] = [b'/media/fixture\0']
        elif method == 'Unmount':
            if self.fail_unmount:
                raise backend.VolumeError('busy')
            self.state[self.CLEAR][backend.FS]['MountPoints'] = []
        elif method == 'Lock':
            del self.state[self.CLEAR]
            self.state[self.LOOP][backend.ENCRYPTED]['CleartextDevice'] = '/'
        elif method == 'Delete':
            del self.state[self.LOOP]
        else:
            raise AssertionError(method)


class LinuxVolumeTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = os.path.realpath(os.path.join(self.directory.name, 'payload.luks'))
        self.bus = Bus(self.path)

    def action(self, operation, **kwargs):
        return backend.run_image(self.bus, operation, self.path, **kwargs)

    def create(self):
        self.action('create', name='Test', size=128, credential='fixture')

    def test_inventory_remains_visible_without_formatting_support(self):
        bus = Mock()
        bus.objects.return_value = {backend.MANAGER: {backend.MGMT: {'SupportedEncryptionTypes': []}},
                                    '/drive': {backend.DRIVE: {'Removable': True, 'Model': 'Practice', 'Size': 1024}}}
        bus.call.return_value = (False, 'mkfs.ext4')
        inventory = backend.UDisks.inventory(bus)
        self.assertTrue(inventory['supported'])
        self.assertIn('unavailableReason', inventory)
        self.assertGreater(inventory['local']['totalBytes'], 0)
        self.assertEqual(inventory['drives'][0]['name'], 'Practice')

    def test_create_unlock_mount_and_lock(self):
        self.create()
        self.assertEqual(self.action('state'), 'locked')
        self.assertEqual(self.bus.calls, ['Format', 'Lock', 'Delete'])
        self.action('unlock', credential='fixture')
        self.assertEqual(self.action('open'), '/media/fixture')
        self.assertEqual(self.action('state'), 'mounted')
        self.bus.fail_unmount = True
        with self.assertRaisesRegex(backend.VolumeError, 'busy'):
            self.action('lock')
        self.assertEqual(self.action('state'), 'mounted')
        self.bus.fail_unmount = False
        self.action('lock')
        self.assertEqual(self.action('state'), 'locked')

    def test_invalid_image_and_overwrite_refused(self):
        Path(self.path).write_bytes(b'important existing data')
        self.assertEqual(self.action('state'), 'unavailable')
        with self.assertRaises(FileExistsError):
            self.create()
        self.assertEqual(Path(self.path).read_bytes(), b'important existing data')
        with self.assertRaisesRegex(backend.VolumeError, 'invalid'):
            self.action('unlock', credential='fixture')
        self.assertEqual(self.bus.calls, [])

    def test_delete_check_uses_loop_identity_even_with_a_damaged_header(self):
        Path(self.path).write_bytes(b'damaged')
        self.assertTrue(self.action('detached'))
        alias = self.path + '.copy'
        os.link(self.path, alias)
        self.bus.state[self.bus.LOOP] = {backend.LOOP: {'BackingFile': os.fsencode(alias)}}
        self.assertFalse(self.action('detached'))
        os.unlink(alias)
        with self.assertRaisesRegex(backend.VolumeError, 'unknown_attachment'):
            self.action('detached')
        self.assertEqual(self.bus.calls, [])

    def test_failed_mount_relocks_and_detaches_owned_loop(self):
        self.create()
        self.bus.fail_mount = True
        with self.assertRaisesRegex(backend.VolumeError, 'mount'):
            self.action('unlock', credential='fixture')
        self.assertEqual(self.action('state'), 'locked')
        self.assertEqual(self.bus.calls[-2:], ['Lock', 'Delete'])


if __name__ == '__main__':
    unittest.main()
