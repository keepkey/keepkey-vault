import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { getVolumeInventory } from '../src/bun/volume-inventory'

function diskutil(fixtures: Record<string, unknown>) {
  return async <T>(args: string[]) => {
    const key = args.join(' ')
    if (!(key in fixtures)) throw new Error('Unexpected diskutil request: ' + key)
    return fixtures[key] as T
  }
}

test('joins APFS volumes to their physical external drives and shows usable image destination space', async () => {
  const storage = await getVolumeInventory('darwin', diskutil({
    'info -plist /': {
      VolumeName: 'Local Mac', APFSContainerFree: 17, FreeSpace: 0, APFSContainerSize: 300, FileVault: true,
    },
    'list -plist external physical': { AllDisksAndPartitions: [
      { DeviceIdentifier: 'disk0', OSInternal: true },
      { DeviceIdentifier: 'disk4', Size: 256, Partitions: [
        { DeviceIdentifier: 'disk4s1', Content: 'EFI' },
        { DeviceIdentifier: 'disk4s2', Content: 'Apple_APFS' },
      ] },
    ] },
    'apfs list -plist': { Containers: [
      { PhysicalStores: [{ DeviceIdentifier: 'disk0s2' }], Volumes: [{ DeviceIdentifier: 'disk1s1' }] },
      { PhysicalStores: [{ DeviceIdentifier: 'disk4s2' }], Volumes: [
        { DeviceIdentifier: 'disk7s1', Name: 'Practice', APFSVolumeUUID: 'abc', Encryption: true, Locked: true },
        { DeviceIdentifier: 'disk7s2', Name: 'Recovery', APFSVolumeUUID: 'xyz', FileVault: false, Locked: false },
        { DeviceIdentifier: 'disk7s3', Name: 'Preboot', Roles: ['Preboot'] },
        { DeviceIdentifier: 'disk7s4', Name: 'Time Machine', Roles: ['Backup'], APFSVolumeUUID: 'bak' },
      ] },
    ] },
    'info -plist disk4': { MediaName: 'External USB' },
    'info -plist disk7s1': {},
    'info -plist disk7s2': { MountPoint: tmpdir(), WritableVolume: false },
    'info -plist disk7s4': { MountPoint: tmpdir(), WritableVolume: true },
  }), async () => ({ availableBytes: 12, totalBytes: 280 }))
  expect(storage.local).toEqual({ name: 'Local Mac', availableBytes: 12, totalBytes: 280, fileVault: 'on' })
  expect(storage.drives).toEqual([{
    id: 'disk4', name: 'External USB', sizeBytes: 256, volumes: [
      { id: 'disk7s1', uuid: 'abc', name: 'Practice', format: 'APFS', mountPoint: null, encrypted: true, locked: true,
        writable: false, availableBytes: null },
      { id: 'disk7s2', uuid: 'xyz', name: 'Recovery', format: 'APFS', mountPoint: tmpdir(), encrypted: false, locked: false,
        writable: false, availableBytes: expect.any(Number) },
      { id: 'disk7s4', uuid: 'bak', name: 'Time Machine', format: 'APFS', mountPoint: tmpdir(), encrypted: null, locked: null,
        writable: false, availableBytes: expect.any(Number) },
    ],
  }])
})

test('handles an unpartitioned filesystem and missing macOS state', async () => {
  const storage = await getVolumeInventory('darwin', diskutil({
    'info -plist /': { TotalSize: 100, FreeSpace: 0 },
    'list -plist external physical': { AllDisksAndPartitions: [{ DeviceIdentifier: 'disk2', Size: 123 }] },
    'info -plist disk2': { DeviceIdentifier: 'disk2', FilesystemType: 'exfat', VolumeName: 'USB', MountPoint: tmpdir() },
  }), async () => ({ totalBytes: 100, availableBytes: 0 }))
  expect(storage.local?.availableBytes).toBe(0)
  expect(storage.local?.fileVault).toBe('unknown')
  expect(storage.drives[0].volumes[0]).toMatchObject({
    id: 'disk2', name: 'USB', format: 'exfat', encrypted: null, locked: null, mountPoint: tmpdir(), writable: true,
  })
})

test('rejects stale inventory when a device identifier is reused during a scan', async () => {
  await expect(getVolumeInventory('darwin', diskutil({
    'info -plist /': {},
    'list -plist external physical': { AllDisksAndPartitions: [
      { DeviceIdentifier: 'disk4', Partitions: [{ DeviceIdentifier: 'disk4s1', VolumeUUID: 'old' }] },
    ] },
    'info -plist disk4': { MediaName: 'External' },
    'info -plist disk4s1': { VolumeUUID: 'new' },
  }))).rejects.toThrow('changed during the scan')
})

test('does not represent a failed macOS scan as an empty drive list', async () => {
  await expect(getVolumeInventory('darwin', diskutil({}))).rejects.toThrow('Unexpected diskutil')
})

test('returns unsupported without probing another platform', async () => {
  expect(await getVolumeInventory('win32', diskutil({}))).toEqual({ supported: false, local: null, drives: [] })
})
