// Device state types
export type DeviceState = 'disconnected' | 'connected_unpaired' | 'error' | 'bootloader' | 'needs_firmware' | 'needs_init' | 'needs_pin' | 'needs_passphrase' | 'ready'
export type UpdatePhase = 'idle' | 'entering_bootloader' | 'flashing' | 'rebooting'
export type ActiveTransport = 'hid' | 'webusb' | null

// PIN request types — maps to KeepKey PinMatrixRequestType
export type PinRequestType = 'current' | 'new-first' | 'new-second'

export interface PinRequest {
  type: PinRequestType
}

export interface DeviceStateInfo {
  state: DeviceState
  activeTransport: ActiveTransport
  updatePhase: UpdatePhase
  deviceId?: string
  label?: string
  firmwareVersion?: string
  bootloaderVersion?: string
  latestFirmware?: string
  latestBootloader?: string
  bootloaderMode: boolean
  needsBootloaderUpdate: boolean
  needsFirmwareUpdate: boolean
  needsInit: boolean
  initialized: boolean
  isOob: boolean
  error?: string | null
}

export interface FirmwareProgress {
  percent: number
  message: string
}

// Remote firmware manifest (from GitHub)
export interface FirmwareManifest {
  latest: {
    firmware: { version: string; url: string; hash: string }
    bootloader: { version: string; url: string; hash: string }
  }
  beta: {
    firmware: { version: string; url: string; hash: string }
    bootloader: { version: string; url: string; hash: string }
  }
  hashes: {
    bootloader: Record<string, string>
    firmware: Record<string, string>
  }
}

// Electrobun RPC Schema
export interface BunRPCRequests {
  getDeviceState: { params: void; response: DeviceStateInfo }
  startBootloaderUpdate: { params: void; response: void }
  startFirmwareUpdate: { params: void; response: void }
  flashFirmware: { params: void; response: void }
  resetDevice: { params: { wordCount: 12 | 18 | 24; pin: boolean; passphrase: boolean }; response: void }
  recoverDevice: { params: { wordCount: 12 | 18 | 24; pin: boolean; passphrase: boolean }; response: void }
  applySettings: { params: { label?: string }; response: void }
  sendPin: { params: { pin: string }; response: void }
  sendPassphrase: { params: { passphrase: string }; response: void }
}

export interface BunRPCMessages {
  'device-state': DeviceStateInfo
  'firmware-progress': FirmwareProgress
  'pin-request': PinRequest
}
