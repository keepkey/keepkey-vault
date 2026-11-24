export interface LocalVolumeStorage {
  name: string
  totalBytes: number
  availableBytes: number
  fileVault: 'on' | 'off' | 'unknown'
}

export interface ConnectedVolume {
  id: string
  uuid: string | null
  name: string
  format: string
  mountPoint: string | null
  encrypted: boolean | null
  locked: boolean | null
  availableBytes: number | null
  writable: boolean
}

export interface ConnectedDrive {
  id: string
  name: string
  sizeBytes: number
  volumes: ConnectedVolume[]
}

export interface VolumeInventory {
  supported: boolean
  unavailableReason?: string
  local: LocalVolumeStorage | null
  drives: ConnectedDrive[]
}

export interface VolumeDestination {
  id: string
  uuid: string
}

export interface VolumeImageTarget {
  id: string
  destination?: VolumeDestination
}

export interface VolumeDeleteTarget extends VolumeImageTarget {
  deleteToken: string
}

export type VolumeProgressEvent = { phase: 'approval'; keyLabel: string } | { phase: 'creating' | 'unlocking' }
export type VolumeProgress = VolumeProgressEvent & { operationId: string }

export interface VolumeImage extends VolumeImageTarget {
  name: string
  deleteToken?: string
  unlockMethod: 'keepkey' | 'password'
  state: 'locked' | 'mounted' | 'attached' | 'unavailable'
}

export interface VolumeDeviceStatus {
  available: boolean
  reason: 'ready' | 'disconnected' | 'unsupported' | 'emulator'
}
