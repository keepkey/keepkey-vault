import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { VolumeImage, VolumeInventory } from '../shared/volumes'
import type { VolumeBackend } from './volume-native-types'
import helper from './volume-linux.py' with { type: 'text' }

const execute = promisify(execFile)
const errors: Record<string, string> = {
  unavailable: 'Linux volumes require UDisks2, python3-dbus, and LUKS2 and ext4 support.',
  denied: 'Linux storage authorization was declined.',
  busy: 'The volume is in use. Close its files and retry.',
  changed: 'The attached volume changed. Refresh its state.',
  unknown_attachment: 'Linux could not verify an attached disk image. Close unused disk images and retry deleting the volume.',
  ambiguous: 'This volume is attached more than once. Close it in the system disk utility first.',
  locked: 'Unlock this volume before opening it.',
  invalid: 'Linux could not verify this encrypted LUKS2 volume.',
  operation: 'UDisks2 could not complete the volume operation. Refresh and check the drive and KeepKey wallet.',
}

async function run<T>(action: string, args: string[] = [], credential?: Buffer): Promise<T> {
  // Isolated mode excludes user Python modules. Only the static helper and public image metadata are argv.
  const child = execute('/usr/bin/python3', ['-I', '-c', helper, action, ...args], { maxBuffer: 4 * 1024 * 1024 })
  child.child.stdin?.on('error', () => { /* Child exit is handled below. */ })
  child.child.stdin?.end(credential)
  let result: { result: T; error?: string }
  try {
    result = JSON.parse((await child).stdout)
  } catch {
    throw new Error(action === 'inventory' ? errors.unavailable : errors.operation)
  }
  if (result.error) throw new Error(errors[result.error] ?? errors.operation)
  return result.result
}

export const linuxVolumeBackend: VolumeBackend = {
  filename: 'payload.luks',
  async inventory() {
    try {
      return await run<VolumeInventory>('inventory')
    } catch {
      return { supported: false, unavailableReason: errors.unavailable, local: null, drives: [] }
    }
  },
  state: path => run<VolumeImage['state']>('state', [path]),
  isDetached: path => run<boolean>('detached', [path]),
  create: (path, name, sizeMiB, credential) => run<void>('create', [path, name, String(sizeMiB)], credential),
  unlock: (path, credential) => run<void>('unlock', [path], credential),
  lock: path => run<void>('lock', [path]),
  async open(path) {
    const mount = await run<string>('open', [path])
    if (!mount.startsWith('/')) throw new Error(errors.changed)
    try {
      await execute('/usr/bin/xdg-open', [mount])
    } catch {
      throw new Error('Linux could not open the mounted volume in the file manager.')
    }
  },
}
