import { execFile } from 'node:child_process'
import { constants, createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, rmdir, stat, statfs, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VolumeDeleteTarget, VolumeDestination, VolumeImage, VolumeImageTarget, VolumeInventory } from '../shared/volumes'
import { makeVolumeKeyRecord, parseVolumeKeyRecord, type VolumeKeyRecord } from '../shared/volume-key'
import { getVolumeInventory, runMacPlist } from './volume-inventory'
import type { VolumeBackend } from './volume-native-types'
import { deletionSnapshot, removeVolumeFiles } from './volume-delete'

const HDIUTIL = '/usr/bin/hdiutil'
const SUFFIX = '.sparseimage'
const PACKAGE = '.kkvolume'
const IMAGE = 'volume.sparseimage'
const RECORD = 'recovery.json'
const MIN_MIB = 128
const MAX_MIB = 65536
const namePattern = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} _-]{0,63}$/u
const windowsDevice = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/i

type Entity = { 'dev-entry'?: string; 'mount-point'?: string }
type Attachment = { 'image-path': string; 'image-encrypted'?: boolean; 'system-entities': Entity[] }
type ImageInfo = { images: Attachment[] }

function imageName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter a volume name.')
  const name = value.normalize('NFC')
  if (name.trim() !== name || !namePattern.test(name) || (process.platform === 'win32' && windowsDevice.test(name))) {
    throw new Error('Use 1–64 letters, numbers, spaces, hyphens or underscores. Start with a letter or number.')
  }
  return name
}

function nameFromId(id: unknown): string {
  if (typeof id !== 'string' || id.startsWith('.') || /[/\\\x00-\x1f]/u.test(id)) throw new Error('Invalid volume identifier.')
  const suffix = [PACKAGE, SUFFIX].find(suffix => id.endsWith(suffix))
  if (!suffix || id.length === suffix.length) throw new Error('Invalid volume identifier.')
  if (process.platform === 'win32' && (windowsDevice.test(id) || /[:*?"<>|]/.test(id))) throw new Error('Invalid volume identifier.')
  return id.slice(0, -suffix.length).normalize('NFC')
}

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function attachmentState(matches: Attachment[]): VolumeImage['state'] {
  if (!matches.length) return 'locked'
  return matches.some(item => item['system-entities'].some(entity => entity['mount-point'])) ? 'mounted' : 'attached'
}

const macVolumeSteps = new Map([
  ['attach', 'macOS could not mount the protected volume.'],
  ['detach', 'macOS could not lock the volume.'],
  ['create', 'macOS could not create the encrypted disk image.'],
  ['imageinfo', 'The new volume failed its credential check.'],
  ['-a', 'Finder could not open the mounted volume.'],
])

// Only known descriptions and a numeric exit status can cross into the renderer.
// Native diagnostics can contain paths, user-supplied volume names and other private data.
export function macVolumeFailure(args: string[], stderr: string, error: { code?: string | number | null; killed?: boolean }) {
  const step = args[0]
  const status = macVolumeSteps.get(step) ?? 'macOS could not complete the volume action.'
  if (error.killed) return status + ' The operation timed out. Refresh to check the current state.'
  if (/cancell?ed/i.test(stderr)) return 'Cancelled in macOS.'
  if (/authentication error|authentication failed|incorrect password/i.test(stderr)) {
    if (step === 'attach' && args.includes('-stdinpass')) {
      return 'macOS rejected the volume credential from KeepKey. Check that you selected the original wallet, including its passphrase if you used one, and that recovery.json belongs to this volume.'
    }
    if (step === 'attach') return 'macOS rejected the disk image password. Try the password used to create this volume.'
    return status + ' macOS rejected the disk image credential.'
  }
  if (/no mountable file\s*systems?/i.test(stderr)) {
    return 'macOS opened the disk image but could not mount the filesystem inside it. Keep the original package and use a backup copy for recovery.'
  }
  if (/corrupt image|image data corrupted/i.test(stderr)) {
    return status + ' macOS reported damaged disk image data. Preserve the original and use a backup copy if available.'
  }
  if (/image not recognized|not a recognized disk image|invalid disk image/i.test(stderr)) {
    return status + ' The disk image format was unrecognized. Keep the original intact and use a separate copy for recovery checks.'
  }
  if (/resource busy|resource temporarily unavailable|in use|couldn.t unmount/i.test(stderr)) {
    return status + ' The volume is in use. Close files and apps using it, then try again.'
  }
  if (/operation not permitted|permission denied/i.test(stderr)) {
    return status + ' Check that Vault can access the drive in System Settings under Privacy & Security, Files & Folders.'
  }
  if (/no such file|device not configured|no such device/i.test(stderr)) {
    return status + ' Check that the drive is connected and that the volume package is still on it.'
  }
  if (/no space left/i.test(stderr)) return status + ' There is insufficient disk space.'
  if (/input\/output error/i.test(stderr)) return status + ' macOS reported a disk I/O error. Check the drive connection and preserve the original package.'
  const code = typeof error.code === 'number' && Number.isSafeInteger(error.code) ? ` (exit status ${error.code})` : ''
  return status + ` macOS returned an unrecognized error${code}.`
}

async function nativeAction(command: string, args: string[], input?: Buffer) {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(command, args, { timeout: 5 * 60_000, env: { ...process.env, LC_ALL: 'C' } }, (error, _out, stderr) => {
      if (!error) return resolve()
      reject(new Error(macVolumeFailure(args, stderr, error)))
    })
    // A process that exited early will also report its exit status through execFile.
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}

type KeyProvider = (record: VolumeKeyRecord) => Promise<Buffer>

async function readRecord(folder: string): Promise<VolumeKeyRecord> {
  try {
    if (!(await lstat(folder)).isDirectory() || !(await lstat(join(folder, RECORD))).isFile()) throw new Error()
    const handle = await open(join(folder, RECORD), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > 1024) throw new Error()
      const bytes = new Uint8Array(1025)
      const { bytesRead } = await handle.read(bytes)
      if (bytesRead > 1024) throw new Error()
      return parseVolumeKeyRecord(JSON.parse(new TextDecoder().decode(bytes.subarray(0, bytesRead))))
    } finally { await handle.close() }
  } catch { throw new Error('The public recovery file is missing or invalid. Restore recovery.json from a copy of this volume package.') }
}

// The renderer supplies a filename from the inventory. Only the native side resolves paths or device nodes.
export function createVolumeImageStore(
  directory = join(homedir(), 'KeepKey Volumes'),
  action = nativeAction,
  plist = runMacPlist,
  inventory = getVolumeInventory,
  approve: KeyProvider = async () => { throw new Error('Connect a compatible KeepKey to approve this volume.') },
  backend?: VolumeBackend,
) {
  const pending = new Set<string>()
  const filename = backend?.filename ?? IMAGE
  const scan = () => backend ? backend.inventory() : inventory()

  async function withCredential(record: VolumeKeyRecord, onApproval: ((record: VolumeKeyRecord) => void) | undefined,
    operation: (password: Buffer) => Promise<void>) {
    onApproval?.(record)
    const password = await approve(record)
    if (!Buffer.isBuffer(password)) throw new Error('KeepKey returned an invalid volume credential.')
    try {
      if (!password.length || password.includes(0)) throw new Error('KeepKey returned an invalid volume credential.')
      await operation(password)
    } finally { password.fill(0) }
  }

  async function hdiutilWithCredential(args: string[], password: Buffer) {
    const input = Buffer.alloc(password.length + 1)
    input.set(password)
    try { await action(HDIUTIL, args, input) } finally { input.fill(0) }
  }

  async function createMacImage(path: string, name: string, sizeMiB: number, password: Buffer,
    device: bigint, verifyStaging: () => Promise<void>) {
    // On exFAT, hdiutil create can report success for an encrypted sparse image that rejects its password.
    // Build on the Mac's temporary filesystem, copy only ciphertext, then authenticate the destination.
    const scratch = await mkdtemp(join(tmpdir(), 'keepkey-volume-'))
    try {
      const image = join(scratch, IMAGE)
      await hdiutilWithCredential(['create', '-type', 'SPARSE', '-fs', 'APFS', '-size', `${sizeMiB}m`,
        '-volname', name, '-encryption', 'AES-256', '-stdinpass', image], password)
      await verifyStaging()
      const file = await open(path, 'wx', 0o600)
      try {
        const initial = await file.stat({ bigint: true })
        if (!initial.isFile() || initial.dev !== device) throw new Error('The storage destination changed.')
        for await (const chunk of createReadStream(image)) await file.writeFile(chunk)
        await file.sync()
        await verifyStaging()
        // exFAT assigns the file its cluster-based inode when the first data is written.
        const written = await file.stat({ bigint: true })
        const copied = await lstat(path, { bigint: true })
        if (copied.dev !== device || copied.dev !== written.dev || copied.ino !== written.ino) throw new Error('The storage destination changed.')
        await hdiutilWithCredential(['imageinfo', '-plist', '-stdinpass', path], password)
      } finally { await file.close() }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  async function root(folder: string, create = false) {
    if (!backend && process.platform !== 'darwin') throw new Error('Encrypted volumes are unavailable on this platform.')
    if (create) {
      try { await mkdir(folder, { mode: 0o700 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const info = await lstat(folder)
    if (!info.isDirectory()) throw new Error('The KeepKey Volumes folder must be a local directory.')
    return realpath(folder)
  }

  async function withDestination(destination: VolumeDestination | undefined, create: boolean, operation: (folder: string, verify: () => Promise<void>) => Promise<void>) {
    if (destination === undefined) return operation(await root(directory, create), async () => {})
    const { drives } = await scan()
    const volume = drives.flatMap(drive => drive.volumes).find(v => v.id === destination?.id && v.uuid && v.uuid === destination.uuid)
    if (!volume?.mountPoint || volume.locked || (create && !volume.writable)) throw new Error('Reconnect the selected volume and check that it is mounted and writable.')
    const mount = volume.mountPoint
    const { id, uuid } = volume
    // Keep a handle to this mount throughout the action. A disconnected SSD must never redirect creation to the startup disk.
    const pinned = await lstat(mount, { bigint: true })
    if (!pinned.isDirectory()) throw new Error('The storage destination changed.')
    const handle = process.platform === 'win32' ? null : await open(mount, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    async function verify() {
      const current = await lstat(mount, { bigint: true })
      if (!current.isDirectory() || current.dev !== pinned.dev || current.ino !== pinned.ino) throw new Error('The storage destination changed.')
      if (!backend) {
        const disk = await plist<{ DeviceIdentifier: string; VolumeUUID?: string; APFSVolumeUUID?: string; MountPoint: string }>('/usr/sbin/diskutil', ['info', '-plist', mount])
        if (disk.DeviceIdentifier !== id || (disk.APFSVolumeUUID ?? disk.VolumeUUID) !== uuid || disk.MountPoint !== mount) {
          throw new Error('The connected volume changed. Refresh and select it again.')
        }
      } else {
        const stillMounted = (await scan()).drives.flatMap(drive => drive.volumes).some(v => v.id === id && v.uuid === uuid && v.mountPoint === mount)
        if (!stillMounted) throw new Error('The connected volume changed. Refresh and select it again.')
      }
    }
    try {
      await verify()
      const folder = await root(join(mount, 'KeepKey Volumes'), create)
      if ((await lstat(folder, { bigint: true })).dev !== pinned.dev) throw new Error('The storage destination changed.')
      await operation(folder, verify)
    } finally { await handle?.close() }
  }

  async function encrypted(path: string) {
    const info = await plist<{ encrypted: boolean }>(HDIUTIL, ['isencrypted', '-plist', path])
    return info.encrypted === true
  }

  async function attachments() {
    if (backend) return []
    const info = await plist<ImageInfo>(HDIUTIL, ['info', '-plist'])
    if (!Array.isArray(info.images)) throw new Error('macOS could not confirm which images are attached.')
    return info.images
  }

  async function matchImage(items: Attachment[], path: string, requireKnownPaths = false) {
    const backing = await stat(path, { bigint: true })
    const matches: Attachment[] = []
    for (const item of items) {
      const other = item['image-path']
      if (!other && requireKnownPaths) throw new Error('macOS could not identify an attached image. Refresh before deleting.')
      if (!other || other.startsWith('ram://')) continue
      if (other === path) { matches.push(item); continue }
      const info = await stat(other, { bigint: true }).catch(() => {
        if (requireKnownPaths) throw new Error('macOS could not verify an attached image. Close unused disk images and retry.')
        return null
      })
      if (info && info.dev === backing.dev && info.ino === backing.ino) matches.push(item)
    }
    return matches
  }

  async function imageStatus(folder: string, id: string, items: Attachment[]) {
    const packaged = id.endsWith(PACKAGE)
    const container = join(folder, id)
    if (packaged && !(await lstat(container)).isDirectory()) throw new Error('Choose a valid volume package.')
    if (backend && !packaged) throw new Error('This legacy macOS image requires macOS.')
    const path = packaged ? join(container, filename) : container
    const info = await lstat(path, { bigint: true })
    if (!info.isFile()) throw new Error('Choose a valid encrypted volume.')
    if (backend) {
      const state = await backend.state(path)
      if (state === 'unavailable') throw new Error('Storage encryption is unavailable for this volume.')
      return { path, container, info, matches: [], packaged, state }
    }
    const matches = await matchImage(items, path)
    // hdiutil isencrypted can fail with resource busy while the image is mounted.
    const valid = matches.length ? matches.every(item => item['image-encrypted'] === true) : await encrypted(path)
    if (!valid) throw new Error('macOS could not verify disk image encryption.')
    return { path, container, info, matches, packaged, state: attachmentState(matches) }
  }

  async function listFolder(directoryPath: string, destination: VolumeDestination | undefined, currentAttachments: () => Promise<Attachment[]>): Promise<VolumeImage[]> {
    const folder = await root(directoryPath).catch(error => {
      if (isMissing(error) || destination) return null
      throw error
    })
    if (!folder) return []
    const entries = await readdir(folder, { withFileTypes: true }).catch(error => {
      if (destination) return []
      throw error
    })
    const files = entries.filter(entry => {
      const legacy = !backend && entry.isFile() && entry.name.endsWith(SUFFIX)
      const packaged = entry.isDirectory() && entry.name.endsWith(PACKAGE)
      if (!legacy && !packaged) return false
      try { nameFromId(entry.name); return true } catch { return false }
    })
    if (!files.length) return []
    const items = await currentAttachments()
    const result: VolumeImage[] = []
    for (const entry of files) {
      let state: VolumeImage['state'] = 'unavailable'
      try {
        const image = await imageStatus(folder, entry.name, items)
        if (image.packaged && image.state === 'locked') await readRecord(image.container)
        state = image.state
      } catch { /* damaged images remain visible */ }
      const deleteToken = state === 'mounted' || state === 'attached' ? undefined
        : await deletionSnapshot(folder, entry.name, filename, entry.isDirectory()).then(snapshot => snapshot.token).catch(() => undefined)
      result.push({
        id: entry.name, name: nameFromId(entry.name), state,
        ...(deleteToken && { deleteToken }),
        unlockMethod: entry.name.endsWith(PACKAGE) ? 'keepkey' : 'password',
        ...(destination && { destination }),
      })
    }
    return result
  }

  async function listVolumeImages(known?: VolumeInventory): Promise<VolumeImage[]> {
    const { drives } = known ?? await scan()
    let items: Promise<Attachment[]> | undefined
    const current = () => items ??= attachments()
    const folders = [listFolder(directory, undefined, current)]
    for (const drive of drives) {
      for (const volume of drive.volumes) {
        if (volume.mountPoint && volume.uuid && !volume.locked) {
          folders.push(listFolder(join(volume.mountPoint, 'KeepKey Volumes'), { id: volume.id, uuid: volume.uuid }, current))
        }
      }
    }
    return (await Promise.all(folders)).flat().sort((a, b) => a.name.localeCompare(b.name))
  }

  async function exclusive(name: string, operation: () => Promise<void>) {
    const key = name.normalize('NFC').toLowerCase()
    if (pending.has(key)) throw new Error('A volume action is already in progress.')
    pending.add(key)
    try { await operation() } finally { pending.delete(key) }
  }

  async function createVolumeImage(input: { name: string; sizeMiB: number; destination?: VolumeDestination }, onNativeStart?: () => void,
    onApproval?: (record: VolumeKeyRecord) => void) {
    const name = imageName(input?.name)
    const size = input.sizeMiB
    if (!Number.isInteger(size) || size < MIN_MIB || size > MAX_MIB) {
      throw new Error('Choose a size between 128 and 65536 MiB.')
    }
    await withDestination(input.destination, true, (folder, verify) => exclusive(join(folder, name), async () => {
      const target = join(folder, name + PACKAGE)
      for (const path of [target, join(folder, name + SUFFIX)]) {
        try {
          await lstat(path)
          throw new Error('A file already uses that volume name.')
        } catch (error) { if (!isMissing(error)) throw error }
      }
      const space = await statfs(folder)
      if (size * 1024 ** 2 > space.bavail * space.bsize) throw new Error('Choose a smaller size for the available disk space.')
      const staging = await mkdtemp(join(folder, '.creating-'))
      const stagedImage = join(staging, filename)
      const stagedRecord = join(staging, RECORD)
      const stagedInfo = await lstat(staging, { bigint: true })
      const sameStaging = async () => {
        const current = await lstat(staging, { bigint: true }).catch(() => null)
        return !!current && current.isDirectory() && current.dev === stagedInfo.dev && current.ino === stagedInfo.ino
      }
      let published = false
      try {
        const record = makeVolumeKeyRecord()
        await writeFile(stagedRecord, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 })
        const verifyStaging = async () => {
          await verify()
          if (!await sameStaging() || (await readRecord(staging)).id !== record.id) throw new Error('Volume location changed during creation.')
        }
        await withCredential(record, onApproval, async password => {
          await verifyStaging()
          onNativeStart?.()
          if (backend) await backend.create(stagedImage, name, size, password, record.id)
          else await createMacImage(stagedImage, name, size, password, stagedInfo.dev, verifyStaging)
        })
        const valid = backend ? await backend.state(stagedImage) === 'locked' : await encrypted(stagedImage)
        if (!valid) throw new Error('Could not confirm that the new disk image is encrypted and locked.')
        await verifyStaging()
        // Reserve the final name exclusively. A same-filesystem rename publishes the complete package.
        const reserve = process.platform !== 'win32'
        if (reserve) await mkdir(target, { mode: 0o700 })
        try {
          await rename(staging, target)
          published = true
        } catch (error) {
          if (reserve) await rmdir(target)
          throw error
        }
      } finally {
        if (!published && await sameStaging()) {
          await rm(stagedImage, { force: true })
          await rm(stagedRecord, { force: true })
          await rmdir(staging)
        }
      }
    }))
  }

  async function withImage(input: VolumeImageTarget, operation: (image: Awaited<ReturnType<typeof imageStatus>>, verify: () => Promise<void>) => Promise<void>) {
    const name = nameFromId(input?.id)
    await withDestination(input.destination, false, (folder, verify) => exclusive(join(folder, name), async () => {
      await operation(await imageStatus(folder, input.id, await attachments()), verify)
    }))
  }

  async function unlockVolumeImage(input: VolumeImageTarget, onNativeStart?: () => void, onApproval?: (record: VolumeKeyRecord) => void) {
    await withImage(input, async ({ path, container, info, state, packaged }, verify) => {
      if (state === 'mounted') return
      if (state === 'attached') throw new Error('Lock the attached image before unlocking it again.')
      const attach = ['attach', '-noautoopen', '-mount', 'required']
      if (packaged) {
        const record = await readRecord(container)
        await withCredential(record, onApproval, async password => {
          await verify()
          const file = await lstat(path, { bigint: true })
          if (file.dev !== info.dev || file.ino !== info.ino || (await readRecord(container)).id !== record.id) throw new Error('Volume changed during approval.')
          onNativeStart?.()
          if (backend) await backend.unlock(path, password, record.id)
          else await hdiutilWithCredential([...attach, '-stdinpass', path], password)
        })
      } else {
        await action(HDIUTIL, [...attach, '-agentpass', path])
      }
      const current = backend ? await backend.state(path) : attachmentState(await matchImage(await attachments(), path))
      if (current !== 'mounted') throw new Error('Could not confirm the volume mounted.')
    })
  }

  async function lockVolumeImage(input: VolumeImageTarget) {
    await withImage(input, async ({ path, matches: items, state }) => {
      if (backend) {
        if (state !== 'locked') await backend.lock(path)
        if (await backend.state(path) !== 'locked') throw new Error('The image is still attached. Close files and try locking again.')
        return
      }
      if (!items.length) return
      const device = items[0]['system-entities'][0]?.['dev-entry']
      if (!device || !/^\/dev\/disk\d+$/.test(device)) throw new Error('macOS could not identify the disk image.')
      await action(HDIUTIL, ['detach', device])
      if ((await matchImage(await attachments(), path)).length) throw new Error('The image is still attached. Close files and try locking again.')
    })
  }

  async function openVolumeImage(input: VolumeImageTarget) {
    await withImage(input, async ({ path, matches: items, state }) => {
      if (state !== 'mounted') throw new Error('Unlock the volume to open it.')
      if (backend) return backend.open(path)
      const mount = items.flatMap(item => item['system-entities']).find(entity => entity['mount-point'])?.['mount-point']
      if (!mount?.startsWith('/')) throw new Error('Unlock the volume to open it in Finder.')
      await action('/usr/bin/open', ['-a', 'Finder', mount])
    })
  }

  async function deleteVolumeImage(input: VolumeDeleteTarget) {
    const name = nameFromId(input?.id)
    if (typeof input.deleteToken !== 'string' || !/^[0-9a-f]{64}$/.test(input.deleteToken)) throw new Error('Refresh and confirm which volume to delete.')
    const packaged = input.id.endsWith(PACKAGE)
    if (backend && !packaged) throw new Error('This legacy macOS image requires macOS.')
    await withDestination(input.destination, false, (folder, verify) => exclusive(join(folder, name), async () => {
      const inspect = async () => {
        const snapshot = await deletionSnapshot(folder, input.id, filename, packaged)
        if (snapshot.token !== input.deleteToken) throw new Error('The selected volume changed. Refresh and confirm deletion again.')
        return snapshot
      }
      const snapshot = await inspect()
      const target = join(folder, input.id)
      const path = packaged ? join(target, filename) : target
      if (backend && snapshot.image && !await backend.isDetached(path)) throw new Error('Lock the volume and close files using it before deleting.')
      if (!backend) {
        const items = await attachments()
        const attached = snapshot.image ? (await matchImage(items, path, true)).length > 0 : items.some(item => item['image-path'] === path)
        if (attached) throw new Error('Lock the volume before deleting.')
      }
      await verify()
      const confirmed = await inspect()
      await removeVolumeFiles(folder, input.id, filename, packaged, confirmed)
    }))
  }

  return { listVolumeImages, createVolumeImage, unlockVolumeImage, lockVolumeImage, openVolumeImage, deleteVolumeImage }
}
