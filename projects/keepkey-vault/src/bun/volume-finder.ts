import { isAbsolute } from 'node:path'
import { getVolumeInventory } from './volume-inventory'

async function openMacItem(args: string[]) {
  if (process.platform !== 'darwin') throw new Error('Volumes requires macOS.')
  const child = Bun.spawn(['/usr/bin/open', ...args], { stdio: ['ignore', 'ignore', 'ignore'] })
  if (await child.exited !== 0) throw new Error('macOS could not open the selected item.')
}

export async function openExternalVolume(target: { id: string; uuid: string | null }) {
  const { drives } = await getVolumeInventory()
  // Resolve the mount point again after the click. macOS reuses disk IDs.
  const volume = drives.flatMap(drive => drive.volumes).find(v => v.id === target.id && v.uuid === target.uuid)
  if (!volume?.mountPoint || !isAbsolute(volume.mountPoint)) {
    throw new Error('The selected volume is no longer mounted. Refresh the drive list.')
  }
  await openMacItem(['-a', 'Finder', volume.mountPoint])
}

export function openVolumeFileVaultSettings() {
  return openMacItem(['x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?FileVault'])
}
