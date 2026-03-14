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
  isSwapDeposit?: boolean // THORChain/Maya: use MsgDeposit instead of MsgSend (for swaps/LP)
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
  // ── Activity tracking (populated for sign/broadcast operations) ──
  txid?: string          // blockchain txid (computed from signed tx or from broadcast response)
  chain?: string         // chain symbol (BTC, ETH, ATOM, etc.)
  activityType?: string  // sign | broadcast | swap | message
}

// Supported fiat currencies
export type FiatCurrency = 'USD' | 'EUR' | 'GBP' | 'JPY' | 'CHF' | 'CAD' | 'AUD' | 'CNY' | 'KRW' | 'BRL' | 'RUB' | 'INR' | 'MXN' | 'SEK' | 'NOK' | 'DKK' | 'PLN' | 'CZK' | 'HUF' | 'TRY'

// Application-level settings (persisted in SQLite)
export interface AppSettings {
  restApiEnabled: boolean   // controls entire REST API server on/off
  pioneerApiBase: string    // current Pioneer API base URL
  fiatCurrency: FiatCurrency  // display currency (default 'USD')
  numberLocale: string        // number formatting locale (default 'en-US')
  swapsEnabled: boolean       // feature flag: cross-chain swaps (default OFF)
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

// ── Swap types ─────────────────────────────────────────────────────────

/** An asset available for swapping (THORChain pool asset) */
export interface SwapAsset {
  asset: string            // THORChain asset name (e.g. "BTC.BTC", "ETH.USDT-0xDAC...")
  chainId: string          // our chain id (e.g. "bitcoin", "ethereum")
  symbol: string           // display symbol ("BTC", "USDT")
  name: string             // display name ("Bitcoin", "Tether USD")
  chainFamily: 'utxo' | 'evm' | 'cosmos' | 'xrp'
  decimals: number
  caip?: string            // CAIP-19 if known
  icon?: string            // icon URL
  contractAddress?: string // for ERC-20 tokens
}

/** Quote response from Pioneer (aggregated across DEXes) */
export interface SwapQuote {
  expectedOutput: string     // human-readable amount out
  minimumOutput: string      // after slippage
  inboundAddress: string     // vault address to send to
  router?: string            // EVM router contract (for depositWithExpiry)
  memo: string               // THORChain routing memo (empty for memoless integrations)
  expiry?: number            // unix timestamp — deadline for depositWithExpiry
  fees: {
    affiliate: string        // affiliate fee (human-readable)
    outbound: string         // outbound gas fee
    totalBps: number         // total fee in basis points
  }
  estimatedTime: number      // seconds
  warning?: string           // streaming swap note, dust threshold, etc.
  slippageBps: number        // actual slippage in bps
  fromAsset: string          // THORChain asset identifier
  toAsset: string            // THORChain asset identifier
  integration?: string       // DEX source: "thorchain", "shapeshift", "chainflip", etc.
}

/** Parameters for getSwapQuote RPC */
export interface SwapQuoteParams {
  fromAsset: string   // THORChain asset id (converted to CAIP in swap.ts for Pioneer)
  toAsset: string     // THORChain asset id (converted to CAIP in swap.ts for Pioneer)
  amount: string      // human-readable amount
  fromAddress: string // sender address
  toAddress: string   // destination address
  slippageBps?: number // slippage tolerance (default 300 = 3%)
}

/** Parameters for executeSwap RPC */
export interface ExecuteSwapParams {
  fromChainId: string       // our chain id
  toChainId: string         // our chain id
  fromAsset: string         // THORChain asset id
  toAsset: string           // THORChain asset id
  amount: string            // human-readable amount
  memo: string              // THORChain routing memo
  inboundAddress: string    // vault address
  router?: string           // EVM router (for token approvals)
  expiry?: number           // unix timestamp for depositWithExpiry
  expectedOutput: string    // for display
  isMax?: boolean
  feeLevel?: number
}

/** Result of executeSwap RPC */
export interface SwapResult {
  txid: string
  fromAsset: string
  toAsset: string
  fromAmount: string
  expectedOutput: string
  approvalTxid?: string
}

// ── Swap tracking types ───────────────────────────────────────────────

export type SwapTrackingStatus = 'signing' | 'pending' | 'confirming' | 'output_detected' | 'output_confirming' | 'output_confirmed' | 'completed' | 'failed' | 'refunded'

export interface PendingSwap {
  txid: string
  fromAsset: string       // THORChain asset id (e.g. "BASE.ETH")
  toAsset: string         // THORChain asset id (e.g. "ETH.ETH")
  fromSymbol: string
  toSymbol: string
  fromChainId: string     // our chain id
  toChainId: string
  fromAmount: string      // human-readable
  expectedOutput: string  // human-readable
  memo: string
  inboundAddress: string
  router?: string
  integration: string     // "thorchain", "shapeshift", etc.
  status: SwapTrackingStatus
  confirmations: number
  outboundConfirmations?: number
  outboundRequiredConfirmations?: number
  outboundTxid?: string
  createdAt: number       // unix ms
  updatedAt: number       // unix ms
  estimatedTime: number   // seconds
  error?: string
}

export interface SwapStatusUpdate {
  txid: string
  status: SwapTrackingStatus
  confirmations?: number
  outboundConfirmations?: number
  outboundRequiredConfirmations?: number
  outboundTxid?: string
  error?: string
}

/** Persisted swap history record (SQLite) — tracks the full lifecycle */
export interface SwapHistoryRecord {
  id: string                     // unique row id (UUID)
  txid: string                   // inbound transaction hash
  fromAsset: string              // THORChain asset id
  toAsset: string
  fromSymbol: string
  toSymbol: string
  fromChainId: string
  toChainId: string
  fromAmount: string             // human-readable amount sent
  quotedOutput: string           // expected output at quote time
  minimumOutput: string          // minimum after slippage at quote time
  receivedOutput?: string        // actual received (filled on completion)
  slippageBps: number            // slippage tolerance used
  feeBps: number                 // total fee in basis points
  feeOutbound: string            // outbound gas fee quoted
  integration: string            // "thorchain", "shapeshift", "chainflip"
  memo: string
  inboundAddress: string         // vault address
  router?: string
  status: SwapTrackingStatus
  outboundTxid?: string
  error?: string
  createdAt: number              // unix ms — when swap was initiated
  updatedAt: number              // unix ms — last status update
  completedAt?: number           // unix ms — when terminal status reached
  estimatedTimeSeconds: number   // estimated time at quote time
  actualTimeSeconds?: number     // actual duration (completedAt - createdAt)
  approvalTxid?: string          // ERC-20 approval tx (if applicable)
}

/** Filter params for getSwapHistory RPC */
export interface SwapHistoryFilter {
  status?: SwapTrackingStatus | 'all'
  fromDate?: number       // unix ms
  toDate?: number         // unix ms
  asset?: string          // filter by fromAsset or toAsset containing this
  limit?: number
  offset?: number
}

/** Stats summary for swap history */
export interface SwapHistoryStats {
  totalSwaps: number
  completed: number
  failed: number
  refunded: number
  pending: number
}

// ── Recent Activity types ──────────────────────────────────────────────

export type ActivityType = 'send' | 'swap' | 'sign' | 'message' | 'approve'
export type ActivitySource = 'app' | 'api'

export interface RecentActivity {
  id: string
  txid?: string              // blockchain txid (may be absent for sign-only before broadcast)
  chain: string              // chain symbol (BTC, ETH, ATOM, etc.)
  chainId?: string           // internal chain id (bitcoin, ethereum, etc.) — for explorer links
  type: ActivityType
  source: ActivitySource
  to?: string
  amount?: string
  asset?: string             // token symbol if different from chain native
  appName?: string           // for API-originating activities
  status: 'signed' | 'broadcast' | 'failed'
  createdAt: number
}

// RPC types — derived from the single source of truth in rpc-schema.ts
// Import VaultRPCSchema from './rpc-schema' if you need the full Electrobun schema.
// These aliases are for convenience in frontend code that doesn't need Electrobun types.
