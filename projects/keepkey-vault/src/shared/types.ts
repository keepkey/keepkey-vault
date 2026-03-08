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
  resolvedFwVersion?: string  // firmware version resolved from on-device hash (bootloader mode only)
  firmwareHash?: string
  bootloaderHash?: string
  firmwareVerified?: boolean
  bootloaderVerified?: boolean
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

// Custom firmware analysis (drag & drop flash)
export interface FirmwareAnalysis {
  isSigned: boolean
  hasKpkyHeader: boolean
  detectedVersion: string | null
  payloadHash: string
  fileSize: number
  isBootloaderMode: boolean
  currentFirmwareVersion: string | null  // null in bootloader mode (FW version unknown)
  deviceBootloaderVersion: string | null
  currentFirmwareVerified: boolean | undefined
  isDowngrade: boolean
  isSameVersion: boolean
  willWipeDevice: boolean  // true when going from signed → unsigned (not in BL mode)
}

// Pioneer integration types
export interface TokenBalance {
  symbol: string           // [DB] TEXT NOT NULL — token ticker (e.g. "USDT")
  name: string             // [DB] TEXT NOT NULL — display name (e.g. "Tether USD")
  balance: string          // [DB] TEXT NOT NULL DEFAULT '0' — human-readable balance
  balanceUsd: number       // [DB] REAL NOT NULL DEFAULT 0 — total USD value
  priceUsd: number         // [DB] REAL NOT NULL DEFAULT 0 — per-unit USD price
  caip: string             // [DB] TEXT NOT NULL — CAIP-19 identifier (e.g. "eip155:1/erc20:0x...")
  contractAddress?: string // [DB] TEXT — contract address (extracted from CAIP)
  networkId?: string       // [DB] TEXT — CAIP-2 network (e.g. "eip155:1")
  icon?: string            // [DB] TEXT — icon URL (keepkey.info or override)
  decimals?: number        // [DB] INTEGER — token decimals (e.g. 6 for USDT, 18 for most ERC-20)
  type?: string            // [DB] TEXT — "native" | "token" | "unknown"
  dataSource?: string      // data origin: "zapper" | "blockbook" | "cache"
}

export interface ChainBalance {
  chainId: string
  symbol: string
  balance: string       // human-readable (e.g. "0.001")
  balanceUsd: number
  address: string
  tokens?: TokenBalance[]
}

export interface BuildTxParams {
  chainId: string
  to: string
  amount: string
  memo?: string
  feeLevel?: number   // 1=slow, 5=avg, 10=fast
  isMax?: boolean
  caip?: string        // Token CAIP-19 — triggers token transfer mode when contains 'erc20'
  tokenBalance?: string  // human-readable token balance (from frontend) — avoids re-fetch on max send
  tokenDecimals?: number // token decimals (from frontend) — avoids re-fetch
  xpubOverride?: string        // BTC multi-account: use this xpub instead of default
  scriptTypeOverride?: string  // BTC multi-account: use this scriptType instead of default
  accountPath?: number[]       // BTC multi-account: account-level path [purpose+H, coinType+H, account+H]
  evmAddressIndex?: number     // EVM multi-address: derivation index (default 0)
}

// ── Bitcoin multi-account types ─────────────────────────────────────────
export type BtcScriptType = 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh'

export interface BtcXpub {
  scriptType: BtcScriptType
  purpose: number              // 44, 49, or 84
  path: number[]               // [purpose+H, 0+H, account+H]
  xpub: string                 // xpub/ypub/zpub string
  xpubPrefix: 'xpub' | 'ypub' | 'zpub'
  balance: string
  balanceUsd: number
}

export interface BtcAccount {
  accountIndex: number
  xpubs: BtcXpub[]             // always 3 (one per script type)
  totalBalanceUsd: number
}

export interface BtcAccountSet {
  accounts: BtcAccount[]
  totalBalanceUsd: number
  totalBalance: string
  selectedXpub?: { accountIndex: number; scriptType: BtcScriptType }
}

// ── EVM multi-address types ─────────────────────────────────────────
export interface EvmTrackedAddress {
  addressIndex: number     // derivation index (m/44'/60'/0'/0/{index})
  address: string          // 0x-prefixed checksummed address
  balanceUsd: number       // aggregate USD across all EVM chains
}

export interface EvmAddressSet {
  addresses: EvmTrackedAddress[]
  selectedIndex: number
  totalBalanceUsd: number
}

export interface BuildTxResult {
  unsignedTx: any
  fee: string
  feeUsd?: number
}

export interface BroadcastResult {
  txid: string
}

// Custom token / chain types
export interface CustomToken {
  chainId: string         // parent chain id (e.g. 'polygon')
  contractAddress: string // 0x-prefixed checksummed
  symbol: string
  name: string
  decimals: number
  networkId: string       // CAIP-2 (e.g. 'eip155:137')
}

export interface CustomChain {
  chainId: number
  name: string
  symbol: string          // gas token symbol
  rpcUrl: string
  explorerUrl?: string
  explorerAddressLink?: string  // template with {{address}} placeholder
  explorerTxLink?: string       // template with {{txid}} placeholder
}

// Pioneer discovery catalog entry (from /api/v1/discovery/search)
export interface PioneerChainInfo {
  chainId: number
  name: string
  symbol: string
  icon: string
  explorer: string
  explorerAddressLink: string
  explorerTxLink: string
  color: string
  decimals: number
  rpcUrl?: string
  rpcUrls?: string[]
}

// Token visibility (spam filter user overrides)
export type TokenVisibilityStatus = 'visible' | 'hidden'

export interface TokenVisibilityEntry {
  caip: string
  status: TokenVisibilityStatus
  updatedAt: number
}

// ── REST API bridge types ─────────────────────────────────────────────
export interface PairingRequestInfo {
  name: string
  url: string
  imageUrl: string
}

export interface PairedAppInfo {
  apiKey: string
  name: string
  url: string
  imageUrl: string
  addedOn: number
}

export interface EIP712DecodedField {
  label: string
  value: string
  format: 'address' | 'amount' | 'datetime' | 'raw' | 'hex'
  raw?: string
}

export interface EIP712DecodedInfo {
  operationName: string
  domain: { name?: string; version?: string; chainId?: number; verifyingContract?: string }
  primaryType: string
  fields: EIP712DecodedField[]
  isKnownType: boolean
}

export interface SigningRequestInfo {
  id: string
  method: string
  appName: string
  chain?: string
  from?: string
  to?: string
  value?: string
  data?: string
  chainId?: number
  typedDataDecoded?: EIP712DecodedInfo
}

export interface ApiLogEntry {
  id?: number            // SQLite rowid (set after DB insert)
  method: string
  route: string
  timestamp: number
  durationMs: number     // response time in ms
  status: number
  appName: string
  imageUrl?: string
  requestBody?: any      // parsed JSON body (POST requests)
  responseBody?: any     // parsed JSON response
}

// Application-level settings (persisted in SQLite)
export interface AppSettings {
  restApiEnabled: boolean   // controls entire REST API server on/off
  pioneerApiBase: string    // current Pioneer API base URL
}

// ── RPC param/response types for top-use endpoints ──────────────────────

export interface BtcGetAddressParams {
  addressNList: number[]
  coin?: string
  scriptType?: string
  showDisplay?: boolean
}

export interface EthGetAddressParams {
  addressNList: number[]
  showDisplay?: boolean
  coin?: string
}

export interface EthSignTxParams {
  addressNList: number[]
  to: string
  value: string
  data?: string
  nonce: string
  gasLimit: string
  chainId: number
  gasPrice?: string
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
}

export interface BtcSignTxParams {
  coin: string
  inputs: any[] // TODO: type BTCSignTxInput
  outputs: any[] // TODO: type BTCSignTxOutput
  version?: number
  locktime?: number
}

export interface GetPublicKeysParams {
  paths: Array<{
    addressNList: number[]
    curve?: string
    showDisplay?: boolean
    coin?: string
    scriptType?: string
  }>
}

// ── App Update types ─────────────────────────────────────────────────
export interface UpdateInfo {
  version: string
  hash: string
  updateAvailable: boolean
  updateReady: boolean
  error: string
}

export interface UpdateStatus {
  status: string
  message: string
  timestamp: number
  progress?: number
  bytesDownloaded?: number
  totalBytes?: number
  errorMessage?: string
}

// ── Report types ────────────────────────────────────────────────────

export interface ReportMeta {
  id: string
  createdAt: number
  chain: string
  totalUsd: number
  status: 'generating' | 'complete' | 'error'
  error?: string
}

export interface ReportData {
  title: string
  subtitle: string
  generatedDate: string
  chain?: string
  sections: ReportSection[]
}

export type ReportSection =
  | { title: string; type: 'table'; data: { headers: string[]; rows: string[][]; widths?: string[] } }
  | { title: string; type: 'summary'; data: string[] }
  | { title: string; type: 'list'; data: string[] }
  | { title: string; type: 'text'; data: string }

// RPC types — derived from the single source of truth in rpc-schema.ts
// Import VaultRPCSchema from './rpc-schema' if you need the full Electrobun schema.
// These aliases are for convenience in frontend code that doesn't need Electrobun types.
