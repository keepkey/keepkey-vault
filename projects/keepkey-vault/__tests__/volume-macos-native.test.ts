import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { createVolumeImageStore } from '../src/bun/volume-images'
import { runMacPlist } from '../src/bun/volume-inventory'
import type { VolumeInventory } from '../src/shared/volumes'

const HDIUTIL = '/usr/bin/hdiutil'
type Attachment = {
  'image-path': string
  'image-encrypted': boolean
  'system-entities': { 'dev-entry': string; 'mount-point'?: string }[]
}

async function attachments(path: string) {
  const result = await runMacPlist<{ images: Attachment[] }>(HDIUTIL, ['info', '-plist'])
  return result.images.filter(image => image['image-path'] === path)
}

async function detachFixtureImage(path: string) {
  for (const image of await attachments(path)) {
    const wholeDisk = image['system-entities'].find(entry => /^\/dev\/disk\d+$/.test(entry['dev-entry']))
    assert.ok(wholeDisk, 'Cannot identify disk image ' + path)
    execFileSync(HDIUTIL, ['detach', wholeDisk['dev-entry']], { timeout: 30_000 })
  }
  expect(await attachments(path)).toHaveLength(0)
}

test.skipIf(process.platform !== 'darwin' || process.env.KEEPKEY_TEST_NATIVE_VOLUMES !== '1')(
  'creates, unlocks, deletes and recreates an encrypted APFS volume stored on exFAT', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'keepkey-exfat-')))
    const carrier = join(fixture, 'carrier.sparseimage')
    const drive = join(fixture, 'drive')
    const name = 'KK Test ' + randomUUID().slice(0, 8)
    const id = name + '.kkvolume'
    const innerImage = join(drive, 'KeepKey Volumes', id, 'volume.sparseimage')
    try {
      await mkdir(drive)
      execFileSync(HDIUTIL, ['create', '-size', '512m', '-type', 'SPARSE', '-layout', 'MBRSPUD',
        '-fs', 'ExFAT', '-volname', 'KKTEST', carrier], { timeout: 60_000 })
      execFileSync(HDIUTIL, ['attach', '-noautoopen', '-nobrowse', '-mountpoint', drive, carrier], { timeout: 60_000 })
      const disk = await runMacPlist<{
        DeviceIdentifier: string; ParentWholeDisk: string; VolumeUUID: string
        MountPoint: string; FilesystemType: string; TotalSize: number
      }>('/usr/sbin/diskutil', ['info', '-plist', drive])
      expect(disk.MountPoint).toBe(drive)
      expect(disk.FilesystemType.toLowerCase()).toBe('exfat')
      assert.ok(disk.VolumeUUID)
      const destination = { id: disk.DeviceIdentifier, uuid: disk.VolumeUUID }
      const target = { id, destination }
      // Only this newly mounted carrier is discoverable as external storage in the test.
      const inventory = async (): Promise<VolumeInventory> => ({
        supported: true, local: null, drives: [{ id: disk.ParentWholeDisk, name: 'Test carrier', sizeBytes: disk.TotalSize,
          volumes: [{ ...destination, name: 'KKTEST', mountPoint: drive, format: 'ExFAT',
            locked: false, encrypted: false, writable: true, availableBytes: null }] }],
      })
      const home = join(fixture, 'local')
      const testKey = async () => Buffer.from('01'.repeat(32), 'ascii')
      const store = createVolumeImageStore(home, undefined, runMacPlist, inventory, testKey)

      async function mountedTestFile() {
        const [image] = await attachments(innerImage)
        assert.ok(image?.['image-encrypted'])
        const mount = image['system-entities'].find(entry => entry['mount-point'])?.['mount-point']
        assert.ok(mount && (await stat(mount)).dev !== (await stat(drive)).dev)
        const inner = await runMacPlist<{ FilesystemType: string }>('/usr/sbin/diskutil', ['info', '-plist', mount])
        expect(inner.FilesystemType.toLowerCase()).toBe('apfs')
        // Capture the Finder invocation while exercising the production path and mount checks.
        const opened: string[][] = []
        const finder = createVolumeImageStore(home, async (cmd, args) => { opened.push([cmd, ...args]) },
          runMacPlist, inventory, testKey)
        await finder.openVolumeImage(target)
        expect(opened).toEqual([['/usr/bin/open', '-a', 'Finder', mount]])
        return join(mount, 'roundtrip.txt')
      }

      await store.createVolumeImage({ name, sizeMiB: 128, destination })
      const listed = async () => (await store.listVolumeImages()).find(image => image.id === id)
      const listedState = async () => (await listed())?.state
      expect(await listedState()).toBe('locked')
      const originalToken = (await listed())?.deleteToken
      assert.ok(originalToken)
      expect(await attachments(innerImage)).toHaveLength(0)
      await store.unlockVolumeImage(target)
      expect(await listedState()).toBe('mounted')
      await expect(store.deleteVolumeImage({ ...target, deleteToken: originalToken })).rejects.toThrow()
      const marker = randomUUID()
      await writeFile(await mountedTestFile(), marker, { flag: 'wx' })
      await store.lockVolumeImage(target)
      expect(await listedState()).toBe('locked')
      expect(await attachments(innerImage)).toHaveLength(0)
      await store.unlockVolumeImage(target)
      expect(await readFile(await mountedTestFile(), 'utf8')).toBe(marker)
      await store.lockVolumeImage(target)
      expect(await listedState()).toBe('locked')
      const outside = join(drive, 'ordinary.txt')
      await writeFile(outside, marker, { flag: 'wx' })
      // This disposable image simulates the user's failed practice package.
      await writeFile(innerImage, 'damaged practice image')
      const failed = await listed()
      expect(failed?.state).toBe('unavailable')
      assert.ok(failed?.deleteToken)
      await store.deleteVolumeImage({ ...target, deleteToken: failed.deleteToken })
      expect(await listed()).toBeUndefined()
      expect(await readFile(outside, 'utf8')).toBe(marker)
      await store.createVolumeImage({ name, sizeMiB: 128, destination })
      await expect(store.deleteVolumeImage({ ...target, deleteToken: failed.deleteToken })).rejects.toThrow()
      await store.unlockVolumeImage(target)
      expect(await listedState()).toBe('mounted')
      await store.lockVolumeImage(target)
      expect(await attachments(innerImage)).toHaveLength(0)
    } finally {
      await detachFixtureImage(innerImage)
      await detachFixtureImage(carrier)
      // Never recursively remove a directory that still contains a mounted filesystem.
      const mount = await stat(drive).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e
        return null
      })
      assert.ok(!mount || mount.dev === (await stat(fixture)).dev)
      await rm(fixture, { recursive: true })
    }
  }, 180_000)
