import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readdir, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

const changed = 'The selected volume changed. Refresh and confirm deletion again.'
const extraFiles = 'This package contains additional files. Move them outside the package before deleting the volume.'

function identity(info: BigIntStats) {
  return [info.dev, info.ino, info.birthtimeNs].join(':')
}

function fileVersion(info: BigIntStats) {
  return [identity(info), info.size, info.mtimeNs].join(':')
}

function optionalStat(path: string) {
  return lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

// A filename alone can refer to a newly created volume by the time a confirmation arrives.
export async function deletionSnapshot(folder: string, id: string, payload: string, packaged: boolean) {
  const target = join(folder, id)
  const root = await lstat(folder, { bigint: true })
  const container = await lstat(target, { bigint: true })
  if (!root.isDirectory() || !(packaged ? container.isDirectory() : container.isFile()) || root.dev !== container.dev) {
    throw new Error(changed)
  }
  const image = packaged ? await optionalStat(join(target, payload)) : container
  const record = packaged ? await optionalStat(join(target, 'recovery.json')) : null
  for (const file of [image, record]) {
    if (file && (!file.isFile() || file.dev !== root.dev)) throw new Error(changed)
  }
  const hash = createHash('sha256').update(JSON.stringify([folder, id, identity(root), identity(container),
    image && fileVersion(image), record && fileVersion(record)]))
  // On FAT-family filesystems a quickly recreated package can reuse inode numbers
  // and coarse timestamps. Its freshly generated public recovery ID still differs.
  if (record && record.size <= 1024n) {
    const handle = await open(join(target, 'recovery.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (fileVersion(await handle.stat({ bigint: true })) !== fileVersion(record)) throw new Error(changed)
      const bytes = new Uint8Array(1024)
      const { bytesRead } = await handle.read(bytes)
      hash.update(bytes.subarray(0, bytesRead))
    } finally { await handle.close() }
  }
  const token = hash.digest('hex')
  return { token, root, container, image, record }
}

async function pinDirectory(path: string, expected: BigIntStats) {
  if (process.platform === 'win32') return null
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY)
  try {
    if (identity(await handle.stat({ bigint: true })) !== identity(expected)) throw new Error(changed)
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

// Unlink relative to the open directory on Unix, even if a parent is renamed during removal.
// Windows refuses deletion of attached images through its mandatory file-sharing rules.
async function removeChild(folder: string, parent: FileHandle | null, name: string, directory = false) {
  if (parent && process.platform === 'darwin') {
    const { dlopen, FFIType, ptr } = await import('bun:ffi')
    const libc = dlopen('/usr/lib/libSystem.B.dylib', { unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 } })
    try {
      // Darwin's AT_REMOVEDIR requests rmdir semantics, which requires an empty directory.
      const basename = new TextEncoder().encode(name + '\0')
      if (libc.symbols.unlinkat(parent.fd, ptr(basename), directory ? 0x80 : 0) !== 0) {
        throw new Error('Could not remove the volume files. Check write access, close open files, and try again.')
      }
    } finally { libc.close() }
  } else {
    const base = parent ? '/proc/self/fd/' + parent.fd : folder
    await (directory ? rmdir : unlink)(join(base, name))
  }
}

export async function removeVolumeFiles(folder: string, id: string, payload: string, packaged: boolean,
  snapshot: Awaited<ReturnType<typeof deletionSnapshot>>) {
  const target = join(folder, id)
  const parent = await pinDirectory(folder, snapshot.root)
  try {
    if (!packaged) {
      if (fileVersion(await lstat(target, { bigint: true })) !== fileVersion(snapshot.container)) throw new Error(changed)
      return await removeChild(folder, parent, id)
    }
    const dir = await pinDirectory(target, snapshot.container)
    try {
      const entries = new Map<string, BigIntStats>()
      // Finder may create AppleDouble files for resource forks and metadata on exFAT.
      const names = [payload, 'recovery.json', '._' + payload, '._recovery.json', '.DS_Store', '._.DS_Store']
      for (const entry of await readdir(target, { withFileTypes: true })) {
        if (!names.includes(entry.name) || !entry.isFile()) throw new Error(extraFiles)
        const file = await lstat(join(target, entry.name), { bigint: true })
        if (!file.isFile() || file.dev !== snapshot.container.dev) throw new Error(changed)
        entries.set(entry.name, file)
      }
      for (const [name, expected] of [[payload, snapshot.image], ['recovery.json', snapshot.record]] as const) {
        const found = entries.get(name)
        if (expected ? !found || fileVersion(found) !== fileVersion(expected) : found) throw new Error(changed)
      }
      // Remove the payload first. If it is busy or read-only its recovery record survives intact.
      for (const name of names) {
        const file = entries.get(name)
        if (!file) continue
        if (identity(await lstat(target, { bigint: true })) !== identity(snapshot.container)) throw new Error(changed)
        const current = await optionalStat(join(target, name))
        if (!current && name.startsWith('._')) continue // macOS can remove the paired sidecar itself
        if (!current?.isFile() || fileVersion(current) !== fileVersion(file)) throw new Error(changed)
        await removeChild(target, dir, name)
      }
    } finally { await dir?.close() }
    if (identity(await lstat(target, { bigint: true })) !== identity(snapshot.container)) throw new Error(changed)
    await removeChild(folder, parent, id, true)
  } finally { await parent?.close() }
}
