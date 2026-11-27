import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { createVolumeImageStore, macVolumeFailure } from './volume-images'
import type { VolumeBackend } from './volume-native-types'
import type { VolumeInventory } from '../shared/volumes'
import type { VolumeKeyRecord } from '../shared/volume-key'

let dir: string
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'vault-images-'))) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
const digest = (bytes: Buffer) => createHash('sha256').update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)).digest('hex')

function fixture() {
  const folder = join(dir, 'local')
  const external = join(dir, 'external')
  const destination = { id: 'disk77s1', uuid: 'practice-id' }
  const volume = { ...destination, name: 'Practice', format: 'ExFAT', mountPoint: external, encrypted: false, locked: false, writable: true, availableBytes: 10 ** 9 }
  const snapshot: VolumeInventory = {
    supported: true, local: null, drives: [{ id: 'disk77', name: 'SSD', sizeBytes: 10 ** 9, volumes: [volume] }],
  }
  const calls: string[][] = []
  const buffers: Buffer[] = []
  const approvals: string[] = []
  let mounted = ''
  const flags = { stayAttached: false, cancel: false, staleUuid: false, invalidCopy: false, seed: 'practice' }
  const plist = async <T>(command: string, args: string[]) => {
    if (command.endsWith('diskutil')) return { DeviceIdentifier: destination.id, VolumeUUID: flags.staleUuid ? 'other' : destination.uuid, MountPoint: external } as T
    if (args[0] === 'isencrypted') {
      if (mounted === args[2]) throw new Error('Resource busy')
      return { encrypted: (await readFile(args[2], 'utf8')).startsWith('encrypted') } as T
    }
    return { images: mounted ? [{
      'image-path': mounted, 'image-encrypted': true,
      'system-entities': [{ 'dev-entry': '/dev/disk80' }, { 'dev-entry': '/dev/disk81s1', 'mount-point': '/Volumes/Practice' }],
    }] : [] } as T
  }
  const action = async (command: string, args: string[], input?: Buffer) => {
    calls.push([command, ...args])
    if (input) {
      expect(input.at(-1)).toBe(0)
      expect(args.join(' ')).not.toContain(input.subarray(0, -1).toString('ascii'))
      buffers.push(input)
    }
    const path = args.at(-1)!
    if (args[0] === 'create') await writeFile(path, 'encrypted' + digest(input!))
    if (args[0] === 'imageinfo' && (flags.invalidCopy || await readFile(path, 'utf8') !== 'encrypted' + digest(input!))) {
      throw new Error(macVolumeFailure(args, 'hdiutil: imageinfo failed - Authentication error', { code: 80 }))
    }
    if (args[0] === 'attach') {
      if (input && await readFile(path, 'utf8') !== 'encrypted' + digest(input)) throw new Error('authentication failed')
      mounted = path
    }
    if (args[0] === 'detach' && !flags.stayAttached) mounted = ''
  }
  const approve = async (record: VolumeKeyRecord) => {
    approvals.push(record.id)
    if (flags.cancel) throw new Error('Cancelled')
    const bytes = Buffer.from(createHash('sha256').update(flags.seed + record.id).digest('base64url'), 'ascii')
    buffers.push(bytes)
    return bytes
  }
  const newStore = () => createVolumeImageStore(folder, action, plist, async () => snapshot, approve)
  return { store: newStore(), newStore, calls, approvals, buffers, snapshot, folder, external, destination, flags, approve }
}

describe.skipIf(process.platform !== 'darwin')('encrypted macOS images', () => {
  it('creates a complete package, derives once per unlock, and confirms macOS detached it', async () => {
    const { store, calls, folder, flags, buffers, approvals } = fixture()
    const target = { id: 'Practice.kkvolume' }
    await store.createVolumeImage({ name: 'Practice', sizeMiB: 128 })
    const record = JSON.parse(await readFile(join(folder, target.id, 'recovery.json'), 'utf8'))
    expect(record).toEqual({ version: 1, id: expect.stringMatching(/^[0-9a-f]{32}$/) })
    expect(calls[0].slice(1, -1)).toEqual(['create', '-type', 'SPARSE', '-fs', 'APFS', '-size', '128m', '-volname', 'Practice', '-encryption', 'AES-256', '-stdinpass'])
    expect((await store.listVolumeImages())[0]).toMatchObject({ ...target, name: 'Practice', unlockMethod: 'keepkey', state: 'locked' })
    await store.unlockVolumeImage(target)
    expect(calls.at(-1)).toEqual(['/usr/bin/hdiutil', 'attach', '-noautoopen', '-mount', 'required', '-stdinpass', join(folder, target.id, 'volume.sparseimage')])
    expect((await store.listVolumeImages())[0].state).toBe('mounted')
    await store.openVolumeImage(target)
    expect(calls.at(-1)).toEqual(['/usr/bin/open', '-a', 'Finder', '/Volumes/Practice'])
    flags.stayAttached = true
    await expect(store.lockVolumeImage(target)).rejects.toThrow('still attached')
    flags.stayAttached = false
    await store.lockVolumeImage(target)
    expect(calls.at(-1)).toEqual(['/usr/bin/hdiutil', 'detach', '/dev/disk80'])
    expect((await store.listVolumeImages())[0].state).toBe('locked')
    expect(approvals).toEqual([record.id, record.id])
    expect(buffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true)
  })

  it('recovers after renaming the package and replacing the device, rejects another seed or cancelled approval', async () => {
    const { store, folder, flags, newStore, approvals } = fixture()
    await store.createVolumeImage({ name: 'Original', sizeMiB: 128 })
    const target = { id: 'Renamed (2026).kkvolume' }
    await rename(join(folder, 'Original.kkvolume'), join(folder, target.id))
    flags.seed = 'other'
    await expect(newStore().unlockVolumeImage(target)).rejects.toThrow('authentication')
    flags.cancel = true
    await expect(newStore().unlockVolumeImage(target)).rejects.toThrow('Cancelled')
    expect((await store.listVolumeImages())[0].state).toBe('locked')
    flags.seed = 'practice'
    flags.cancel = false
    await newStore().unlockVolumeImage(target)
    expect((await newStore().listVolumeImages())[0].state).toBe('mounted')
    expect(new Set(approvals).size).toBe(1)
    expect(approvals).toHaveLength(4)
  })

  it('locks without the manifest, then refuses to unlock until the correct manifest is restored', async () => {
    const { store, folder, approvals } = fixture()
    const target = { id: 'Files.kkvolume' }
    await store.createVolumeImage({ name: 'Files', sizeMiB: 128 })
    await store.unlockVolumeImage(target)
    const manifest = join(folder, target.id, 'recovery.json')
    await rm(manifest)
    expect((await store.listVolumeImages())[0].state).toBe('mounted')
    await store.lockVolumeImage(target)
    await expect(store.unlockVolumeImage(target)).rejects.toThrow('missing or invalid')
    await writeFile(manifest, '{"version":2}')
    await expect(store.unlockVolumeImage(target)).rejects.toThrow('missing or invalid')
    expect((await store.listVolumeImages())[0].state).toBe('unavailable')
    expect(approvals).toHaveLength(2)
  })

  it('retains legacy native-prompt images and rejects unsafe paths, invalid images and duplicates', async () => {
    const { store, folder, calls, approvals } = fixture()
    await expect(store.createVolumeImage({ name: '../Escape', sizeMiB: 128 })).rejects.toThrow()
    await expect(store.createVolumeImage({ name: 'Huge', sizeMiB: 65537 })).rejects.toThrow()
    await expect(store.unlockVolumeImage({ id: '../Escape.sparseimage' })).rejects.toThrow()
    await mkdir(folder)
    await writeFile(join(folder, 'Taken.sparseimage'), 'unprotected')
    await expect(store.createVolumeImage({ name: 'Taken', sizeMiB: 256 })).rejects.toThrow('already uses')
    await symlink(join(folder, 'Taken.sparseimage'), join(folder, 'Link.sparseimage'))
    await expect(store.unlockVolumeImage({ id: 'Link.sparseimage' })).rejects.toThrow('valid encrypted')
    expect(await store.listVolumeImages()).toMatchObject([{ id: 'Taken.sparseimage', name: 'Taken', state: 'unavailable', unlockMethod: 'password' }])
    await writeFile(join(folder, 'Legacy.sparseimage'), 'encrypted')
    await store.unlockVolumeImage({ id: 'Legacy.sparseimage' })
    expect(calls.at(-1)).toContain('-agentpass')
    expect(approvals).toHaveLength(0)
  })

  it('cancels cleanly and targets the fresh external mount by UUID', async () => {
    const { store, destination, external, snapshot, flags } = fixture()
    await mkdir(external)
    const params = { name: 'Files', sizeMiB: 128, destination }
    flags.cancel = true
    await expect(store.createVolumeImage(params)).rejects.toThrow('Cancelled')
    expect(await readdir(join(external, 'KeepKey Volumes'))).toEqual([])
    flags.cancel = false
    await store.createVolumeImage(params)
    const target = { id: 'Files.kkvolume', destination }
    expect(await store.listVolumeImages()).toContainEqual(expect.objectContaining({ ...target, name: 'Files', state: 'locked', unlockMethod: 'keepkey' }))
    flags.staleUuid = true
    await expect(store.unlockVolumeImage(target)).rejects.toThrow('changed')
    snapshot.drives[0].volumes = []
    await expect(store.openVolumeImage(target)).rejects.toThrow('Reconnect')
  })

  it('creates locally, checks the actual destination credential, and removes unpublished copies on failure', async () => {
    const { store, destination, external, flags, calls, approvals, buffers } = fixture()
    await mkdir(external)
    const volumeRoot = join(external, 'KeepKey Volumes')
    const params = { name: 'Practice', sizeMiB: 128, destination }
    flags.invalidCopy = true
    await expect(store.createVolumeImage(params)).rejects.toThrow('credential check')
    const scratchImage = calls.find(args => args[1] === 'create')!.at(-1)!
    const checkedImage = calls.find(args => args[1] === 'imageinfo')!.at(-1)!
    expect(scratchImage.startsWith(volumeRoot)).toBe(false)
    expect(checkedImage.startsWith(join(volumeRoot, '.creating-'))).toBe(true)
    expect(checkedImage).not.toBe(scratchImage)
    await expect(readdir(dirname(scratchImage))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(volumeRoot)).toEqual([])
    expect(approvals).toHaveLength(1)
    expect(buffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true)
    flags.invalidCopy = false
    await store.createVolumeImage(params)
    expect(await readdir(volumeRoot)).toEqual(['Practice.kkvolume'])
    expect(approvals).toHaveLength(2)
  })

  it('deletes a failed package with AppleDouble files and can recreate the same name without any delete approval', async () => {
    const { store, folder, approvals } = fixture()
    const params = { name: 'Retry', sizeMiB: 128 }
    const id = params.name + '.kkvolume'
    await store.createVolumeImage(params)
    const packagePath = join(folder, id)
    await writeFile(join(packagePath, 'volume.sparseimage'), 'damaged')
    await writeFile(join(packagePath, 'recovery.json'), 'bad metadata')
    for (const file of ['._volume.sparseimage', '._recovery.json', '.DS_Store']) await writeFile(join(packagePath, file), 'metadata')
    await writeFile(join(folder, 'ordinary.txt'), 'kept')
    const [listed] = await store.listVolumeImages()
    expect(listed.state).toBe('unavailable')
    const target = { id, deleteToken: listed.deleteToken! }
    await store.deleteVolumeImage(target)
    expect(approvals).toHaveLength(1)
    expect(await readdir(folder)).toEqual(['ordinary.txt'])
    await store.createVolumeImage(params)
    const replacement = (await store.listVolumeImages())[0]
    expect(replacement.deleteToken).not.toBe(target.deleteToken)
    await expect(store.deleteVolumeImage(target)).rejects.toThrow('changed')
    expect(await readFile(join(folder, 'ordinary.txt'), 'utf8')).toBe('kept')
    await store.unlockVolumeImage({ id })
    await expect(store.deleteVolumeImage({ id, deleteToken: replacement.deleteToken! })).rejects.toThrow('Lock')
    expect((await store.listVolumeImages())[0].deleteToken).toBeUndefined()
  })

  it('rejects unrelated entries and links before removing any part of the package', async () => {
    const { store, folder } = fixture()
    const id = 'My files.kkvolume'
    const target = join(folder, id)
    await store.createVolumeImage({ name: 'My files', sizeMiB: 128 })
    const [listed] = await store.listVolumeImages()
    const token = { id, deleteToken: listed.deleteToken! }
    await mkdir(join(target, 'saved files'))
    await expect(store.deleteVolumeImage(token)).rejects.toThrow('additional files')
    await rm(join(target, 'saved files'), { recursive: true })
    const outside = join(dir, 'outside')
    await writeFile(outside, 'private')
    await symlink(outside, join(target, '._recovery.json'))
    await expect(store.deleteVolumeImage(token)).rejects.toThrow('additional files')
    expect(await readFile(outside, 'utf8')).toBe('private')
    expect(await readdir(target)).toContain('volume.sparseimage')
    await expect(store.deleteVolumeImage({ ...token, id: '../My files.kkvolume' })).rejects.toThrow('Invalid volume identifier')
    await rm(join(target, '._recovery.json'))
    await rename(target, join(dir, 'moved'))
    await symlink(join(dir, 'moved'), target)
    await expect(store.deleteVolumeImage(token)).rejects.toThrow()
    expect(await readdir(join(dir, 'moved'))).toContain('recovery.json')
  })

  it('can finish deleting a package missing its payload or metadata and uses a separate token for a legacy image', async () => {
    const { store, folder } = fixture()
    await mkdir(folder)
    const id = 'Retry.kkvolume'
    await mkdir(join(folder, id))
    await writeFile(join(folder, id, 'recovery.json'), 'corrupt')
    await writeFile(join(folder, 'Legacy.sparseimage'), 'encrypted')
    const listed = await store.listVolumeImages()
    const legacy = listed.find(image => image.id.endsWith('.sparseimage'))!
    const partial = listed.find(image => image.id === id)!
    await expect(store.deleteVolumeImage({ id, deleteToken: legacy.deleteToken! })).rejects.toThrow('changed')
    await store.deleteVolumeImage({ id, deleteToken: partial.deleteToken! })
    await store.deleteVolumeImage({ id: legacy.id, deleteToken: legacy.deleteToken! })
    expect(await readdir(folder)).toEqual([])
    await mkdir(join(folder, id))
    await writeFile(join(folder, id, 'volume.sparseimage'), 'damaged')
    const [missingRecord] = await store.listVolumeImages()
    await store.deleteVolumeImage({ id, deleteToken: missingRecord.deleteToken! })
    expect(await readdir(folder)).toEqual([])
  })
})

describe('macOS disk image diagnostics', () => {
  it.each([
    ['Authentication error', 'macOS rejected the volume credential from KeepKey'],
    ['no mountable file systems', 'could not mount the filesystem inside'],
    ['no mountable filesystems', 'could not mount the filesystem inside'],
    ['image not recognized', 'disk image format was unrecognized'],
    ['invalid disk image', 'disk image format was unrecognized'],
    ['image data corrupted', 'reported damaged disk image data'],
    ['Resource temporarily unavailable', 'volume is in use'],
    ['Operation not permitted', 'Files & Folders'],
    ['Device not configured', 'drive is connected'],
    ['Input/output error', 'disk I/O error'],
  ])('identifies the attach failure %s', (reason, expected) => {
    const message = macVolumeFailure(['attach', '-stdinpass'], 'hdiutil: attach failed - ' + reason, { code: 1 })
    expect(message).toContain(expected)
  })

  it('distinguishes native password, verification, lock, and Finder failures', () => {
    expect(macVolumeFailure(['attach', '-agentpass'], 'Authentication error', { code: 80 })).toContain('disk image password')
    expect(macVolumeFailure(['imageinfo'], 'Authentication error', { code: 80 })).toContain('credential check')
    expect(macVolumeFailure(['detach'], 'Resource busy', { code: 16 })).toContain('could not lock')
    expect(macVolumeFailure(['-a'], '', { code: null, killed: true })).toContain('Finder could not open')
  })

  it('includes only the stage and exit status for an unfamiliar native error', () => {
    const message = macVolumeFailure(['attach', '-stdinpass', '/private/location'], 'private native diagnostic', { code: 6 })
    expect(message).toContain('could not mount')
    expect(message).toContain('exit status 6')
    expect(message).not.toContain('private')
    expect(message).not.toContain('-stdinpass')
  })
})

it('uses the platform backend for packages and passes the exact credential bytes', async () => {
  const { approve, snapshot, folder, approvals, flags } = fixture()
  const steps: string[] = []
  let mounted = false
  const backend: VolumeBackend = {
    filename: 'volume.luks', inventory: async () => snapshot,
    state: async path => { expect(path.endsWith('volume.luks')).toBe(true); return mounted ? 'mounted' : 'locked' },
    isDetached: async () => !mounted,
    create: async (path, _name, _size, credential) => {
      steps.push('native create')
      expect(credential.includes(0)).toBe(false)
      await writeFile(path, digest(credential))
    },
    unlock: async (path, credential) => {
      steps.push('native unlock')
      expect(digest(credential)).toBe(await readFile(path, 'utf8'))
      mounted = true
    },
    lock: async () => { mounted = false },
    open: async () => {},
  }
  const unsupported = async (): Promise<never> => { throw new Error('macOS command attempted') }
  const store = createVolumeImageStore(folder, unsupported, unsupported, unsupported, async record => {
    const password = await approve(record)
    steps.push('approved')
    return password
  }, backend)
  await store.createVolumeImage({ name: 'Practice', sizeMiB: 128 }, () => steps.push('creating'))
  const target = { id: 'Practice.kkvolume' }
  await store.unlockVolumeImage(target, () => steps.push('unlocking'))
  expect((await store.listVolumeImages())[0].state).toBe('mounted')
  await store.openVolumeImage(target)
  await store.lockVolumeImage(target)
  expect((await store.listVolumeImages())[0].state).toBe('locked')
  expect(approvals).toHaveLength(2)
  flags.cancel = true
  await expect(store.unlockVolumeImage(target, () => steps.push('unlocking'))).rejects.toThrow('Cancelled')
  expect(steps).toEqual(['approved', 'creating', 'native create', 'approved', 'unlocking', 'native unlock'])
})

it('checks native attachments independently of corrupt headers and fails closed on a native status error', async () => {
  const { folder, snapshot } = fixture()
  const id = 'Failed.kkvolume'
  const packagePath = join(folder, id)
  await mkdir(packagePath, { recursive: true })
  await writeFile(join(packagePath, 'image'), 'unreadable')
  const unsupported = async (): Promise<never> => { throw new Error('unsupported') }
  let check: () => Promise<boolean> = unsupported
  const backend: VolumeBackend = {
    filename: 'image', inventory: async () => snapshot, state: async () => 'unavailable',
    isDetached: async path => { expect(path).toBe(join(packagePath, 'image')); return check() },
    create: unsupported, unlock: unsupported, lock: unsupported, open: unsupported,
  }
  const store = createVolumeImageStore(folder, unsupported, unsupported, unsupported, unsupported, backend)
  const [listed] = await store.listVolumeImages()
  const target = { id, deleteToken: listed.deleteToken! }
  await expect(store.deleteVolumeImage(target)).rejects.toThrow('unsupported')
  check = async () => false
  await expect(store.deleteVolumeImage(target)).rejects.toThrow('Lock')
  expect(await readdir(packagePath)).toEqual(['image'])
  check = async () => true
  await store.deleteVolumeImage(target)
  expect(await readdir(folder)).toEqual([])
})

it.skipIf(process.platform !== 'darwin')('previews the same public record used for each approval, including a cancelled unlock', async () => {
  const { store, folder, approvals, flags } = fixture()
  const target = { id: 'Practice.kkvolume' }
  const previewed: string[] = []
  const showPrompt = (record: VolumeKeyRecord) => {
    expect(approvals.length).toBe(previewed.length)
    previewed.push(record.id)
  }
  await store.createVolumeImage({ name: 'Practice', sizeMiB: 128 }, undefined, showPrompt)
  const record = JSON.parse(await readFile(join(folder, target.id, 'recovery.json'), 'utf8'))
  flags.cancel = true
  await expect(store.unlockVolumeImage(target, undefined, showPrompt)).rejects.toThrow('Cancelled')
  expect(previewed).toEqual([record.id, record.id])
  expect(approvals).toEqual(previewed)
  await writeFile(join(folder, target.id, 'recovery.json'), '{"version":1,"id":"invalid"}')
  await expect(store.unlockVolumeImage(target, undefined, showPrompt)).rejects.toThrow()
  expect(previewed).toHaveLength(2)
})
