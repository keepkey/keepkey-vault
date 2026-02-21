// Device state types
export type DeviceState = 'disconnected' | 'connected_unpaired' | 'error' | 'bootloader' | 'needs_firmware' | 'needs_init' | 'needs_pin' | 'needs_passphrase' | 'ready'
export type UpdatePhase = 'idle' | 'entering_bootloader' | 'flashing' | 'rebooting'
export type ActiveTransport = 'hid' | 'webusb' | null

// PIN request types — maps to KeepKey PinMatrixRequestType
export type PinRequestType = 'current' | 'new-first' | 'new-second'

export interface PinRequest {
  type: PinRequestType
}

export interface CharacterRequest {
  wordPos: number      // 0-indexed word position (0 = first word)
  characterPos: number // 0-indexed character position within current word
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

// Pioneer integration types
export interface ChainBalance {
  chainId: string
  symbol: string
  balance: string       // human-readable (e.g. "0.001")
  balanceUsd: number
  address: string
}

export interface BuildTxParams {
  chainId: string
  to: string
  amount: string
  memo?: string
  feeLevel?: number   // 1=slow, 5=avg, 10=fast
  isMax?: boolean
}

export interface BuildTxResult {
  unsignedTx: any
  fee: string
  feeUsd?: number
}

export interface BroadcastResult {
  txid: string
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
  sendCharacter: { params: { character: string }; response: void }
  sendCharacterDelete: { params: void; response: void }
  sendCharacterDone: { params: void; response: void }

  // Wallet operations
  getFeatures: { params: void; response: any }
  ping: { params: { msg?: string }; response: any }
  wipeDevice: { params: void; response: any }
  getPublicKeys: { params: { paths: any[] }; response: any }

  // Address derivation
  btcGetAddress: { params: any; response: any }
  ethGetAddress: { params: any; response: any }
  cosmosGetAddress: { params: any; response: any }
  thorchainGetAddress: { params: any; response: any }
  mayachainGetAddress: { params: any; response: any }
  osmosisGetAddress: { params: any; response: any }
  binanceGetAddress: { params: any; response: any }
  xrpGetAddress: { params: any; response: any }

  // Transaction signing
  btcSignTx: { params: any; response: any }
  ethSignTx: { params: any; response: any }
  ethSignMessage: { params: any; response: any }
  ethSignTypedData: { params: any; response: any }
  ethVerifyMessage: { params: any; response: any }
  cosmosSignTx: { params: any; response: any }
  thorchainSignTx: { params: any; response: any }
  mayachainSignTx: { params: any; response: any }
  osmosisSignTx: { params: any; response: any }
  binanceSignTx: { params: any; response: any }
  xrpSignTx: { params: any; response: any }

  // Pioneer integration
  getBalances: { params: void; response: ChainBalance[] }
  getBalance: { params: { chainId: string }; response: ChainBalance }
  buildTx: { params: BuildTxParams; response: BuildTxResult }
  broadcastTx: { params: { chainId: string; signedTx: any }; response: BroadcastResult }
  getMarketData: { params: { caips: string[] }; response: any }
  getFees: { params: { chainId: string }; response: any }
}

export interface BunRPCMessages {
  'device-state': DeviceStateInfo
  'firmware-progress': FirmwareProgress
  'pin-request': PinRequest
  'character-request': CharacterRequest
  'recovery-error': { message: string; errorType: 'pin-mismatch' | 'invalid-mnemonic' | 'bad-words' | 'cancelled' | 'unknown' }
}
