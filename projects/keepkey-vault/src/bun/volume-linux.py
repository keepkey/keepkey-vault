"""UDisks2 operations on regular image files created by Vault. Runs as the desktop user."""
import fcntl
import json
import os
import stat
import sys
import time

SERVICE = 'org.freedesktop.UDisks2'
ROOT = '/org/freedesktop/UDisks2'
MANAGER = ROOT + '/Manager'
BLOCK = SERVICE + '.Block'
DRIVE = SERVICE + '.Drive'
FS = SERVICE + '.Filesystem'
ENCRYPTED = SERVICE + '.Encrypted'
LOOP = SERVICE + '.Loop'
MGMT = SERVICE + '.Manager'
MAGIC = b'LUKS\xba\xbe\x00\x02'


class VolumeError(Exception):
    pass


def file_path(value):
    return os.fsdecode(bytes(value).rstrip(b'\0'))


def free_bytes(path):
    fs = os.statvfs(path)
    return fs.f_bavail * fs.f_frsize


class UDisks:
    def __init__(self):
        import dbus
        self.dbus = dbus
        self.bus = dbus.SystemBus()
        # Pin the daemon so a restarted service cannot reuse a stale object path.
        self.owner = self.bus.get_name_owner(SERVICE) if self.bus.name_has_owner(SERVICE) else None
        if not self.owner:
            self.bus.start_service_by_name(SERVICE)
            self.owner = self.bus.get_name_owner(SERVICE)

    def interface(self, path, interface):
        return self.dbus.Interface(self.bus.get_object(self.owner, path), interface)

    def objects(self):
        return self.interface(ROOT, 'org.freedesktop.DBus.ObjectManager').GetManagedObjects(byte_arrays=True)

    def call(self, path, interface, method, *args):
        return getattr(self.interface(path, interface), method)(*args, timeout=600)

    def setup_loop(self, fd):
        return self.call(MANAGER, MGMT, 'LoopSetup', self.dbus.types.UnixFd(fd),
                         {'no-part-scan': self.dbus.Boolean(True)})

    def inventory(self):
        objects = self.objects()
        manager = objects[MANAGER][MGMT]
        ext4, _ = self.call(MANAGER, MGMT, 'CanFormat', 'ext4')
        can_create = bool(ext4 and 'luks2' in manager.get('SupportedEncryptionTypes', []))
        drives = {}
        for key, entry in objects.items():
            drive = entry.get(DRIVE)
            if drive and (drive['Removable'] or drive.get('ConnectionBus') in ('usb', 'firewire', 'sdio', 'thunderbolt')):
                drives[key] = dict(id=str(key), name=str(drive['Model']).strip() or 'External drive',
                                   sizeBytes=int(drive['Size']), volumes=[])
        for key, entry in objects.items():
            block = entry.get(BLOCK)
            if not block or block['HintIgnore']:
                continue
            belongs = block['Drive']
            backing = objects.get(block.get('CryptoBackingDevice'), {}).get(BLOCK)
            if backing:
                belongs = backing['Drive']
            if belongs not in drives or (FS not in entry and ENCRYPTED not in entry):
                continue
            mounts = entry.get(FS, {}).get('MountPoints', [])
            mount = file_path(mounts[0]) if mounts else None
            encrypted = bool(backing or ENCRYPTED in entry)
            if ENCRYPTED in entry and entry[ENCRYPTED].get('CleartextDevice', '/') != '/':
                continue  # The mounted cleartext volume is the selectable destination.
            try:
                available = free_bytes(mount) if mount else None
            except OSError:
                available = None
            drives[belongs]['volumes'].append(dict(
                id=str(key), uuid=str(block['IdUUID']) or None,
                name=str(block['IdLabel']) or os.path.basename(file_path(block['Device'])),
                format=str(block['IdType']), mountPoint=mount, encrypted=encrypted,
                locked=ENCRYPTED in entry, availableBytes=available,
                writable=bool(mount and not block['ReadOnly'] and os.access(mount, os.W_OK))))
        home = os.path.expanduser('~')
        fs = os.statvfs(home)
        return dict(supported=True, local=dict(name='Home', availableBytes=free_bytes(home),
                    totalBytes=fs.f_blocks * fs.f_frsize, fileVault='unknown'), drives=list(drives.values()),
                    **({} if can_create else {'unavailableReason': 'Linux volumes require UDisks2, python3-dbus, and LUKS2 and ext4 support.'}))


def loop_matches(objects, path):
    found = [key for key, entry in objects.items() if LOOP in entry and file_path(entry[LOOP]['BackingFile']) == path]
    if len(found) > 1:
        raise VolumeError('ambiguous')
    return found[0] if found else None


def checked_loop(objects, loop, path):
    entry = objects.get(loop, {})
    props = entry.get(LOOP)
    if not props or file_path(props['BackingFile']) != path or int(props['SetupByUID']) != os.getuid():
        raise VolumeError('changed')
    return entry


def clear_device(objects, key):
    encrypted = objects[key].get(ENCRYPTED)
    if encrypted is None:
        return None
    clear = encrypted.get('CleartextDevice', '/')
    if clear == '/':
        return None
    if objects.get(clear, {}).get(BLOCK, {}).get('CryptoBackingDevice') != key:
        raise VolumeError('changed')
    return clear


def image_state(objects, path):
    loop = loop_matches(objects, path)
    if not loop:
        return 'locked', None
    checked_loop(objects, loop, path)
    clear = clear_device(objects, loop)
    mounts = objects.get(clear, {}).get(FS, {}).get('MountPoints', [])
    return ('mounted', file_path(mounts[0])) if mounts else ('attached', None)


def close_loop(bus, path, loop, detach=True):
    objects = bus.objects()
    checked_loop(objects, loop, path)
    clear = clear_device(objects, loop)
    if clear:
        if objects[clear].get(FS, {}).get('MountPoints'):
            bus.call(clear, FS, 'Unmount', {})
        bus.call(loop, ENCRYPTED, 'Lock', {})
    if not detach:
        return
    # Autoclear loops can disappear after locking.
    objects = bus.objects()
    if loop in objects:
        checked_loop(objects, loop, path)
        bus.call(loop, LOOP, 'Delete', {})
    if loop_matches(bus.objects(), path):
        raise VolumeError('busy')


def run_image(bus, action, path, name=None, size=0, credential=''):
    create = action == 'create'
    if action not in ('create', 'unlock', 'lock', 'state', 'open', 'detached'):
        raise VolumeError('invalid')
    if create and not (128 <= size <= 65536 and name):
        raise VolumeError('invalid')
    modify = action in ('create', 'unlock')
    if modify and not credential:
        raise VolumeError('credential')
    flags = os.O_NONBLOCK | os.O_NOFOLLOW | (os.O_RDWR if modify else os.O_RDONLY)
    if create:
        flags |= os.O_CREAT | os.O_EXCL
    fd = os.open(path, flags, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise VolumeError('invalid')
        try:
            lock = fcntl.LOCK_SH if action in ('state', 'open') else fcntl.LOCK_EX
            fcntl.flock(fd, lock | fcntl.LOCK_NB)
        except BlockingIOError:
            raise VolumeError('busy')
        if action == 'detached':
            # A damaged LUKS header can still belong to an active loop. Match aliases
            # by filesystem identity and let an unreadable backing path fail closed.
            image = os.fstat(fd)
            for entry in bus.objects().values():
                if LOOP in entry:
                    backing = file_path(entry[LOOP]['BackingFile'])
                    if backing == path:
                        return False
                    try:
                        if os.path.samestat(os.stat(backing), image):
                            return False
                    except OSError as error:
                        raise VolumeError('unknown_attachment') from error
            return True
        if create:
            os.ftruncate(fd, size * 1024 * 1024)
        elif os.pread(fd, len(MAGIC), 0) != MAGIC:
            if action == 'state':
                return 'unavailable'
            raise VolumeError('invalid')
        path = os.path.realpath(path)
        objects = bus.objects()
        loop = loop_matches(objects, path)
        if action == 'state':
            return image_state(objects, path)[0]
        if action == 'open':
            state, mount = image_state(objects, path)
            if state != 'mounted':
                raise VolumeError('locked')
            return mount
        if action == 'lock':
            if loop:
                close_loop(bus, path, loop)
            return
        if create and loop:
            raise VolumeError('changed')
        owned = loop is None
        unlocked_here = False
        if owned:
            loop = bus.setup_loop(fd)
        try:
            entry = checked_loop(bus.objects(), loop, path)
            if not os.path.samestat(os.stat(path), os.fstat(fd)):
                raise VolumeError('changed')
            if create:
                # Only the just-created O_EXCL regular file on the loop from our own FD can be formatted.
                label = name.encode()[:16].decode(errors='ignore')
                bus.call(loop, BLOCK, 'Format', 'ext4', {'label': label, 'take-ownership': True,
                         'encrypt.type': 'luks2', 'encrypt.passphrase': credential})
                objects = bus.objects()
                checked_loop(objects, loop, path)
                clear = clear_device(objects, loop)
                if os.pread(fd, len(MAGIC), 0) != MAGIC or objects.get(clear, {}).get(BLOCK, {}).get('IdType') != 'ext4':
                    raise VolumeError('invalid')
                close_loop(bus, path, loop)
                return
            # UDisks may return from LoopSetup just before the first content probe is published.
            for _ in range(30):
                if ENCRYPTED in entry:
                    break
                time.sleep(0.1)
                entry = checked_loop(bus.objects(), loop, path)
            if ENCRYPTED not in entry:
                raise VolumeError('invalid')
            objects = bus.objects()
            clear = clear_device(objects, loop)
            if not clear:
                clear = bus.call(loop, ENCRYPTED, 'Unlock', credential, {})
                unlocked_here = True
            objects = bus.objects()
            if clear_device(objects, loop) != clear or objects[clear].get(BLOCK, {}).get('IdType') != 'ext4':
                raise VolumeError('invalid')
            if not objects[clear][FS]['MountPoints']:
                bus.call(clear, FS, 'Mount', {})
            if image_state(bus.objects(), path)[0] != 'mounted':
                raise VolumeError('mount')
        except Exception:
            if owned or unlocked_here:
                objects = bus.objects()
                if loop in objects:
                    close_loop(bus, path, loop, detach=owned)
            raise
    finally:
        # LoopSetup passes a duplicate of this open file description into the kernel.
        # Explicit release lets a later Vault process operate on a mounted image.
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def main():
    action = sys.argv[1]
    try:
        bus = UDisks()
        if action == 'inventory':
            result = bus.inventory()
        else:
            path = sys.argv[2]
            name = sys.argv[3] if action == 'create' else None
            size = int(sys.argv[4]) if action == 'create' else 0
            credential = sys.stdin.buffer.read(512).decode() if action in ('create', 'unlock') else ''
            result = run_image(bus, action, path, name, size, credential)
        print(json.dumps({'result': result}))
    except Exception as error:
        # Only emit fixed error codes. D-Bus errors and method arguments may contain sensitive data.
        code = 'unavailable' if action == 'inventory' else 'operation'
        if isinstance(error, VolumeError):
            code = str(error)
        if hasattr(error, 'get_dbus_name'):
            kind = error.get_dbus_name().split('.')[-1]
            code = {'NotAuthorized': 'denied', 'NotAuthorizedDismissed': 'denied',
                    'NotAuthorizedCanObtain': 'denied', 'DeviceBusy': 'busy'}.get(kind, code)
        print(json.dumps({'error': code}))


if __name__ == '__main__':
    main()
