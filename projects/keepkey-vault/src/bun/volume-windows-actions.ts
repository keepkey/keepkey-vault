import type { VolumeImage } from '../shared/volumes'
import type { VolumeBackend } from './volume-native-types'
import { getWindowsVolumeInventory, openWindowsDrive, queryWindowsJson } from './volume-windows'
import { runWindowsVolumeAction } from './volume-windows-runner'
import stateScript from './volume-windows-state.ps1' with { type: 'text' }

type ImageSnapshot = { state: VolumeImage['state']; mount: string | null }

export async function readWindowsVolumeImage(path: string, checkDetachment = false): Promise<ImageSnapshot> {
  const raw = await queryWindowsJson(stateScript, { KEEPKEY_VOLUME_QUERY_PATH: path, KEEPKEY_VOLUME_CHECK_DETACHED: checkDetachment ? '1' : '' })
  const mount = raw?.mount
  if (raw?.state === 'mounted' && typeof mount === 'string' && /^[A-Z]:\\$/i.test(mount)) return { state: 'mounted', mount }
  if (mount === null && (raw?.state === 'locked' || raw?.state === 'attached')) return { state: raw.state, mount: null }
  return { state: 'unavailable', mount: null }
}

export function createWindowsVolumeBackend(
  readState = readWindowsVolumeImage, action = runWindowsVolumeAction,
  launch = openWindowsDrive,
): VolumeBackend {
  return {
    filename: 'payload.vhdx',
    inventory: getWindowsVolumeInventory,
    state: async path => (await readState(path)).state,
    isDetached: async path => (await readState(path, true)).state === 'locked',
    create: (path, name, sizeMiB, credential, recordId) => action('create', path, { name, sizeMiB, recordId }, credential),
    unlock: (path, credential, recordId) => action('unlock', path, { recordId }, credential),
    lock: path => action('lock', path, {}),
    open: async path => {
      const image = await readState(path)
      if (image.state !== 'mounted' || !image.mount || !/^[A-Z]:\\$/i.test(image.mount)) throw new Error('Unlock the volume before opening it.')
      await launch(image.mount)
    },
  }
}
export const windowsVolumeBackend = createWindowsVolumeBackend()
