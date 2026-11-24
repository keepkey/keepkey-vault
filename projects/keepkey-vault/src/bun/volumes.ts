import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { VolumeDeleteTarget, VolumeInventory, VolumeImageTarget, VolumeDestination } from '../shared/volumes'
import type { VolumeKeyRecord } from '../shared/volume-key'
import { createVolumeImageStore } from './volume-images'
import { getVolumeInventory as getMacInventory, runMacPlist } from './volume-inventory'
import { openExternalVolume as openMacVolume } from './volume-finder'
import { linuxVolumeBackend } from './volume-linux'
import { getWindowsVolumeInventory, openWindowsExternalVolume } from './volume-windows'
import { windowsVolumeBackend } from './volume-windows-actions'

const execute = promisify(execFile)

export async function scanVolumeInventory(): Promise<VolumeInventory> {
  switch (process.platform) {
    case 'darwin': return getMacInventory()
    case 'linux': return linuxVolumeBackend.inventory()
    case 'win32': return getWindowsVolumeInventory()
    default: return { supported: false, local: null, drives: [] }
  }
}

export function createDesktopVolumeStore(approve: (record: VolumeKeyRecord) => Promise<Buffer>) {
  const backend = process.platform === 'win32' ? windowsVolumeBackend : process.platform === 'linux' ? linuxVolumeBackend : undefined
  const store = createVolumeImageStore(join(homedir(), 'KeepKey Volumes'), undefined, runMacPlist,
    scanVolumeInventory, approve, backend)
  const supported = process.platform === 'darwin' || !!backend
  async function requireBackend() {
    if (!supported) throw new Error('Hardware-backed writable volumes are unavailable on this platform.')
    if (backend) {
      const inventory = await backend.inventory()
      if (inventory.unavailableReason || !inventory.supported) {
        throw new Error(inventory.unavailableReason || 'Hardware-backed writable volumes are unavailable on this platform.')
      }
    }
  }
  return {
    listVolumeImages: (inventory: VolumeInventory) => supported && inventory.supported && !inventory.unavailableReason
      ? store.listVolumeImages(inventory) : Promise.resolve([]),
    createVolumeImage: async (params: { name: string; sizeMiB: number; destination?: VolumeDestination },
      onNativeStart?: () => void, onApproval?: (record: VolumeKeyRecord) => void) => {
      await requireBackend()
      return store.createVolumeImage(params, onNativeStart, onApproval)
    },
    unlockVolumeImage: async (params: VolumeImageTarget, onNativeStart?: () => void, onApproval?: (record: VolumeKeyRecord) => void) => {
      await requireBackend()
      return store.unlockVolumeImage(params, onNativeStart, onApproval)
    },
    lockVolumeImage: (params: VolumeImageTarget) => store.lockVolumeImage(params),
    deleteVolumeImage: async (params: VolumeDeleteTarget) => {
      await requireBackend()
      return store.deleteVolumeImage(params)
    },
    openVolumeImage: (params: VolumeImageTarget) => store.openVolumeImage(params),
  }
}

export async function openExternalVolume(target: { id: string; uuid: string | null }) {
  if (process.platform === 'darwin') return openMacVolume(target)
  if (process.platform === 'win32') return openWindowsExternalVolume(target)
  if (process.platform !== 'linux') throw new Error('Unsupported platform.')
  const { drives } = await linuxVolumeBackend.inventory()
  const volume = drives.flatMap(drive => drive.volumes).find(v => v.id === target?.id && v.uuid === target?.uuid)
  if (!volume?.mountPoint || !isAbsolute(volume.mountPoint)) throw new Error('The selected volume is no longer mounted.')
  await execute('/usr/bin/xdg-open', [volume.mountPoint], { timeout: 15_000 })
}
