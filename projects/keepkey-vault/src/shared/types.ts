// Device state types
export type DeviceState = 'disconnected' | 'connected_unpaired' | 'error' | 'bootloader' | 'needs_firmware' | 'needs_init' | 'needs_pin' | 'needs_passphrase' | 'ready'
export type UpdatePhase = 'idle' | 'entering_bootloader' | 'flashing' | 'rebooting'
export type ActiveTransport = 'hid' | 'webusb' | 'tcp' | 'emulator' | null

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
  isEmulator: boolean
  /** True when using a hidden wallet (non-empty passphrase). Reports and chain
   *  history are unavailable; no data is persisted to disk for privacy. */
  isHiddenWallet: boolean
  /** Linux only — set when a KeepKey is enumerated on the USB bus but neither
   *  WebUSB nor HID could open it. Almost always means /etc/udev/rules.d
   *  is missing the 51-keepkey.rules entry. The UI surfaces an auto-fix flow
   *  (writes the rule via pkexec, reloads udev). */
  linuxUdevPermissionDenied?: boolean
}

export interface FirmwareProgress {
  percent: number
  message: string
  /** Present when the update failed. UI should show retry UX; the app itself stays alive. */
  error?: string
}

/** Emitted when the Bun side hits an uncaught error — the UI should show a recovery prompt
 *  rather than silently staring at a frozen screen. */
export interface FatalEvent {
  source: 'uncaught-exception' | 'unhandled-rejection'
  message: string
  stack?: string
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
  willWipeDevice: boolean  // true when crossing signed/unsigned boundary in either direction (not in BL mode)
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
  balanceUsd: number    // total USD (native + tokens)
  nativeBalanceUsd?: number  // native-only USD (excludes tokens)
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

// ── Staking / delegation types ───────────────────────────────────────────
export interface BuildStakingTxParams {
  chainId: string
  validatorAddress: string
  amount: string
  memo?: string
}

export interface StakingPosition {
  type: 'delegation' | 'reward' | 'unbonding'
  balance: string
  valueUsd?: number
  ticker?: string
  validator?: string
  validatorAddress?: string
  status?: string
}

// ── Zcash shielded transaction history ──────────────────────────────────

export interface ZcashTransaction {
  id: number
  value: number            // zatoshis
  block_height: number
  tx_index: number
  is_spent: boolean
  memo: string | null      // decoded UTF-8 text, null if no memo or non-text
  nullifier: string        // hex
  txid: string | null      // hex (for block explorer link)
  action_index: number
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
  iconUrl?: string        // resolved logo (TrustWallet/CoinGecko); undefined when neither matched
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

/**
 * Decoded form of an EIP-191 `personal_sign` payload for the approval UI.
 *
 * The `/eth/sign` REST endpoint accepts `message` as a hex string per the
 * Ethereum JSON-RPC spec. In practice that hex almost always encodes UTF-8
 * text (SIWE auth, dApp login challenges, etc.) — the user needs to see
 * that text to know what they're signing. We surface both forms so the UI
 * can show the decoded string prominently while still giving access to the
 * raw bytes for hash comparison.
 */
export interface EthMessageDecodedInfo {
  /** Signer address (from the request body) — shown so the user confirms which account. */
  address: string
  /** Raw message exactly as received on the wire (typically `0x`-prefixed hex). */
  messageRaw: string
  /** Message interpreted as UTF-8 text. Undefined when the bytes are not valid UTF-8. */
  messageText?: string
  /** True when `messageRaw` looked like hex and successfully round-tripped to UTF-8. */
  isUtf8Text: boolean
}

export interface SolanaMessageDecodedInfo {
  /** Signer pubkey/address shown so the user confirms which account is signing. */
  signer?: string
  /** Raw message value exactly as supplied by the caller. */
  messageRaw: string
  /** Best-effort input encoding used to turn `messageRaw` into bytes for display checks. */
  encoding: 'base58' | 'base64' | 'hex' | 'utf8'
  /** Message interpreted as UTF-8 text. Undefined when the bytes are not valid UTF-8. */
  messageText?: string
  /** Raw bytes as hex for byte-for-byte inspection. */
  messageHex: string
  /** Number of message bytes being signed. */
  byteLength: number
  /** Best-effort sanity check: raw text, opaque bytes, or something shaped like a Solana tx. */
  classification: 'text-message' | 'binary-message' | 'solana-transaction' | 'solana-transaction-message'
  /** Diagnostic from the transaction/message shape check, shown only when useful. */
  sanityCheck?: string
}

// ── Calldata clear-signing types ─────────────────────────────────────────

export interface CalldataDecodedField {
  name: string
  type: string                    // Solidity type (address, uint256, bytes, etc.)
  value: string                   // Human-readable formatted value
  format: 'address' | 'amount' | 'hex' | 'raw'
}

export interface CalldataDecodedInfo {
  dappName: string                // "Aave", "Uniswap", "ERC-20", "Unknown"
  contractName: string            // "AaveV3Pool", "UniversalRouter", etc.
  method: string                  // "supply", "swap", "approve"
  selector: string                // "0x617ba037"
  functionType?: string           // "swap" | "deposit" | "withdraw" | etc.
  fields: CalldataDecodedField[]  // Decoded arguments
  source: 'pioneer' | 'local' | 'none'  // Where the descriptor came from
  /** Pre-signed insight blob (base64) from Pioneer — for firmware clear-signing */
  signedInsightBlob?: string
  /** Signing key slot used for the insight blob */
  insightKeyId?: number
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
  calldataDecoded?: CalldataDecodedInfo   // Clear-signing: decoded contract calldata
  /** Clear-signing: decoded EIP-191 personal_sign message. Always set for /eth/sign requests. */
  ethMessageDecoded?: EthMessageDecodedInfo
  /** Clear-signing: decoded raw Solana message signing payload. */
  solanaMessageDecoded?: SolanaMessageDecodedInfo
  /** Clear-signing: decoded Solana tx — per-instruction rows + resolved ALT accounts */
  solanaDecoded?: SolanaTxDecodedInfo
  /**
   * Populated when a Solana transaction was received but clear-sign decoding
   * failed (malformed wire layout, unsupported message version, RPC outage,
   * etc.). The UI uses this to show an explicit "could not clear-sign"
   * warning instead of silently downgrading the approval dialog to the
   * generic simple-transfer view.
   */
  solanaDecodeError?: string
  /** true when tx has calldata that cannot be fully decoded — device will show blind-signing warning */
  needsBlindSigning?: boolean
  /** true when the UI must enable AdvancedMode before allowing approval */
  requiresAdvancedMode?: boolean
  /** true when device AdvancedMode policy is currently enabled */
  advancedModeEnabled?: boolean
  /** Device firmware version string e.g. "7.14.0" — used to gate blind-signing UI */
  firmwareVersion?: string
  /** Full raw request body from the REST API caller — shown in UI for debugging/transparency */
  rawRequestBody?: Record<string, unknown>
}

/**
 * Clear-signing output for a Solana transaction. Produced by the
 * Vault-side decoder (src/bun/solana-instruction-decoder.ts) and surfaced
 * in SigningApproval so the user sees human-readable per-instruction rows
 * instead of opaque program ids and raw hex. Mirrors the structure used
 * by the future firmware Insight metadata path.
 */
export interface SolanaTxDecodedInstructionArg {
  name: string
  type: 'u8' | 'u16' | 'u32' | 'u64' | 'bool' | 'pubkey' | 'string' | 'bytes'
  value: string
}
export interface SolanaTxDecodedInstructionAccount {
  label?: string
  pubkey: string
}
export interface SolanaTxDecodedInstruction {
  status: 'known' | 'known-program-unknown-ix' | 'unknown-program'
  programId: string
  programName: string
  programCategory?: string
  instructionName?: string
  args: SolanaTxDecodedInstructionArg[]
  accounts: SolanaTxDecodedInstructionAccount[]
  note?: string
}
export interface SolanaTxDecodedInfo {
  version: 'legacy' | 'v0'
  instructions: SolanaTxDecodedInstruction[]
  /** base58 ALT pubkeys referenced by the tx. Empty for legacy. */
  altPubkeys: string[]
  /** True when at least one ALT couldn't be resolved — UI should warn. */
  altResolutionIncomplete?: boolean
  /** True when at least one instruction is from an unknown program. */
  hasUnknownProgram?: boolean
}

export interface ApiLogEntry {
  id?: number            // SQLite rowid (set after DB insert)
  deviceId?: string      // active hardware device id at the time of the log
  walletId?: string      // device+seed scope at the time of the log
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

// Pioneer API server entry (persisted in SQLite)
export interface PioneerServer {
  url: string
  label: string
  isDefault: boolean
}

// Application-level settings (persisted in SQLite)
export interface AppSettings {
  restApiEnabled: boolean        // controls entire REST API server on/off
  pioneerApiBase: string         // current Pioneer API base URL
  pioneerServers: PioneerServer[] // all configured Pioneer servers
  activePioneerServer: string    // URL of the active server
  fiatCurrency: FiatCurrency     // display currency (default 'USD')
  numberLocale: string           // number formatting locale (default 'en-US')
  walletConnectEnabled: boolean   // feature flag: WalletConnect dApp support (default OFF)
  swapsEnabled: boolean          // feature flag: cross-chain swaps (default OFF)
  bip85Enabled: boolean          // feature flag: BIP-85 derived seeds (default OFF)
  zcashPrivacyEnabled: boolean   // feature flag: Zcash shielded/privacy (default OFF, locked)
  emulatorEnabled: boolean       // feature flag: macOS emulator surface (default OFF — dev-only)
  preReleaseUpdates: boolean     // opt-in to pre-release auto-updates (default OFF)
  alphaFirmware: boolean         // opt-in to alpha firmware channel (manifest.beta) (default OFF)
}

// ── WalletConnect types ─────────────────────────────────────────────────
export interface WcSessionInfo {
  topic: string
  peerName: string
  peerUrl: string
  peerIcon: string
  chains: string[]
  expiry: number
}

// ── Emulator types (macOS only — encrypted flash with Keychain) ────────
export type EmulatorProcessState = 'stopped' | 'starting' | 'running' | 'error'

export interface EmulatorStatus {
  state: EmulatorProcessState
  bridgeReady: boolean            // true when emulator is loaded and responding
  host: string                    // transport description
  error?: string
  paired: boolean                 // true when Keychain key exists
  platform: string                // 'darwin' for macOS
  flashImages: string[]           // available encrypted flash images
  storagePath: string             // ~/.keepkey/emulator/
}

/** Info about a single emulator wallet profile (flash image + optional seed). */
export interface EmulatorWalletInfo {
  name: string
  hasMnemonic: boolean
  isActive: boolean
  /** On-device label (Settings → Label). Populated after first connect. */
  label?: string
  /** Hardware-style deviceId returned by Features. Used to join cached balances. */
  deviceId?: string
  /** Sum of cached balance USD across chains for this wallet's deviceId. */
  totalUsd?: number
}

/** Persisted device snapshot — one per device_id, stored in SQLite. */
export interface RegisteredDevice {
  deviceId: string
  label: string
  firmwareVer: string
  updatedAt: number
  totalUsd: number       // sum of cached balance_usd across all chains
}

// ── BIP-85 types ────────────────────────────────────────────────────────

export interface Bip85DeriveParams {
  wordCount: 12 | 18 | 24
  index: number
  label?: string
}

/** Firmware displays seed on device screen only — no mnemonic returned over USB */
export interface Bip85DisplayResult {
  displayed: boolean
  wordCount: 12 | 18 | 24
  index: number
  derivationPath: string
}

/** @deprecated Use Bip85DisplayResult — mnemonic is no longer sent over USB */
export interface Bip85DeriveResult {
  mnemonic: string
  wordCount: 12 | 18 | 24
  index: number
  derivationPath: string
}

export interface Bip85SeedMeta {
  walletFingerprint: string
  wordCount: 12 | 18 | 24
  index: number
  derivationPath: string
  label: string
  createdAt: number
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

/** An asset available for swapping (via THORChain, ChainFlip, Pioneer aggregation, etc.) */
export interface SwapAsset {
  asset: string            // THORChain asset name (e.g. "BTC.BTC", "ETH.USDT-0xDAC...")
  chainId: string          // our chain id (e.g. "bitcoin", "ethereum")
  symbol: string           // display symbol ("BTC", "USDT")
  name: string             // display name ("Bitcoin", "Tether USD")
  chainFamily: string      // chain family (utxo, evm, cosmos, xrp, solana, tron, ton, etc.)
  decimals: number
  caip?: string            // CAIP-19 if known
  icon?: string            // icon URL
  contractAddress?: string // for ERC-20 tokens
}

/** Pre-built EVM transaction from relay/bridge integrations (no memo needed) */
export interface RelayTxParams {
  to: string
  data: string
  value: string              // wei as decimal string
  gasLimit: string
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
  chainId: number
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
  integration?: string       // DEX source: "thorchain", "shapeshift", "chainflip", "relay", etc.
  /** Underlying protocol when `integration` is an aggregator. ShapeShift's swapper
   *  routes through Relay / THORChain / 0x / Uniswap / Curve / etc.; this names
   *  which one will actually execute so the user sees it before signing.
   *  Undefined for non-aggregator integrations (use `integration` directly). */
  swapper?: string
  relayTx?: RelayTxParams    // pre-built tx for relay/bridge integrations (skips memo+router flow)
}

/** Parameters for getSwapQuote RPC.
 *
 *  CAIP is the only identifier the swap stack accepts. Pioneer's Quote
 *  endpoint takes CAIP directly and dispatches to the right swapper
 *  (THORChain / Mayachain / ShapeShift / Relay / 0x). Symbols and
 *  THORChain-style asset names are display concerns — derived from CAIP
 *  by the tracker, not passed as parameters. */
export interface SwapQuoteParams {
  fromCaip: string         // CAIP-19 of the sell asset
  toCaip: string           // CAIP-19 of the buy asset
  amount: string           // human-readable amount
  fromAddress: string      // sender address
  toAddress: string        // destination address
  slippageBps?: number     // slippage tolerance (default 300 = 3%)
}

/** Parameters for executeSwap RPC. CAIP-only identification — the tracker
 *  resolves symbol/name/asset-string for display from the CAIP via
 *  pioneer-discovery. Caller never specifies a token via symbol. */
export interface ExecuteSwapParams {
  fromChainId: string             // our chain id (resolves to ChainDef for signing)
  toChainId: string               // our chain id
  fromCaip: string                // CAIP-19 — primary identifier
  toCaip: string                  // CAIP-19 — primary identifier
  amount: string                  // human-readable amount
  memo: string                    // THORChain routing memo (empty for memoless integrations)
  inboundAddress: string          // vault address
  router?: string                 // EVM router (for token approvals)
  expiry?: number                 // unix timestamp for depositWithExpiry
  expectedOutput: string          // for display
  isMax?: boolean
  feeLevel?: number
  fromAddressOverride?: string    // pre-resolved sender address (skips defaultPath derivation)
  toAddressOverride?: string      // pre-resolved destination address (skips defaultPath derivation)
  integration?: string            // DEX source (relay quotes skip memo+router flow)
  relayTx?: RelayTxParams         // pre-built tx for relay/bridge integrations
}

/** Result of executeSwap RPC */
export interface SwapResult {
  txid: string
  fromCaip: string
  toCaip: string
  fromAmount: string
  expectedOutput: string
  approvalTxid?: string
}

// ── Swap tracking types ───────────────────────────────────────────────

export type SwapTrackingStatus = 'signing' | 'pending' | 'confirming' | 'output_detected' | 'output_confirming' | 'output_confirmed' | 'completed' | 'failed' | 'refunded'

export interface PendingSwap {
  deviceId?: string      // active hardware device id when the swap was submitted
  walletId?: string      // device+seed scope when the swap was submitted
  txid: string
  fromAsset: string       // THORChain asset id (e.g. "BASE.ETH")
  toAsset: string         // THORChain asset id (e.g. "ETH.ETH")
  fromSymbol: string
  toSymbol: string
  fromChainId: string     // our chain id
  toChainId: string
  fromCaip?: string       // CAIP-19 — preserved so the resumed dialog can render the asset logo
  toCaip?: string
  fromAmount: string      // human-readable
  expectedOutput: string  // human-readable (quote-time estimate; replaced with actual when received)
  receivedOutput?: string // actual received amount (filled by Pioneer poll once outbound confirms)
  memo: string
  inboundAddress: string
  router?: string
  integration: string     // "thorchain", "shapeshift", etc.
  swapper?: string        // underlying protocol when integration is an aggregator (e.g. "Relay", "Thorchain", "0x")
  status: SwapTrackingStatus
  confirmations: number
  outboundConfirmations?: number
  outboundRequiredConfirmations?: number
  outboundTxid?: string
  createdAt: number       // unix ms
  updatedAt: number       // unix ms
  completedAt?: number    // unix ms — when terminal status reached
  estimatedTime: number   // seconds
  error?: string
  slippageBps?: number    // slippage tolerance used at quote time (preserved across resumes)
  /** Relay's bytes32 request id (lowercase, 0x-prefixed). Extracted from the
   *  inbound deposit calldata at trackSwap time, or backfilled lazily by
   *  refreshSwap via api.relay.link. Drives the "Relay Track" external link
   *  on relay/shapeshift integrations. */
  relayRequestId?: string
  /** Vault chain id of the actual outbound (refunds outbound on the source chain,
   *  not the destination). Populated by the Maya/Thor classifier — used to route
   *  the explorer link to the correct chain. Falls back to toChainId when absent. */
  outboundChainId?: string
  /** Reason text from a Maya/Thor refund, when status='refunded'. */
  refundReason?: string
  /** Set true when classifySwapOutcome (Midgard) has populated this record.
   *  Once set, Pioneer's mapPioneerStatus is no longer authoritative — Pioneer
   *  cannot distinguish "swap completed" from "refund completed", and would
   *  otherwise ping-pong status with Midgard on every refresh. */
  midgardClassified?: boolean
}

export interface SwapStatusUpdate {
  txid: string
  status: SwapTrackingStatus
  confirmations?: number
  outboundConfirmations?: number
  outboundRequiredConfirmations?: number
  outboundTxid?: string
  error?: string
  /** Underlying protocol detected by the tracker (e.g. "thorchain", "mayachain",
   *  "Relay"). Pioneer surfaces this in `details.protocol.protocol` even when
   *  the original quote response didn't include it — most reliable post-broadcast. */
  swapper?: string
  /** Relay request id (bytes32 hex). Set when the lazy backfill in refreshSwap
   *  resolves it via api.relay.link, so the UI can render the tracker link
   *  without a full re-fetch. */
  relayRequestId?: string
  /** Vault chain id of the actual outbound. Refunds outbound on the source
   *  chain, completions on the destination chain — Midgard's action.out asset
   *  is the only authority. UI uses this to pick the explorer URL. */
  outboundChainId?: string
  /** Refund reason surfaced from the source chain (Midgard) when status='refunded'. */
  refundReason?: string
}

/** Persisted swap history record (SQLite) — tracks the full lifecycle */
export interface SwapHistoryRecord {
  id: string                     // unique row id (UUID)
  deviceId?: string              // active hardware device id when the swap was submitted
  walletId?: string              // device+seed scope when the swap was submitted
  txid: string                   // inbound transaction hash
  fromAsset: string              // THORChain asset id
  toAsset: string
  fromSymbol: string
  toSymbol: string
  fromChainId: string
  toChainId: string
  fromCaip?: string              // CAIP-19 (preserved for icon resolution on resume)
  toCaip?: string
  fromAmount: string             // human-readable amount sent
  quotedOutput: string           // expected output at quote time
  minimumOutput: string          // minimum after slippage at quote time
  receivedOutput?: string        // actual received (filled on completion)
  slippageBps: number            // slippage tolerance used
  feeBps: number                 // total fee in basis points
  feeOutbound: string            // outbound gas fee quoted
  integration: string            // "thorchain", "shapeshift", "chainflip"
  swapper?: string               // underlying protocol when integration is an aggregator
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
  /** Relay request id (bytes32 hex, lowercase). Persisted so the resume path
   *  can render the "Relay Track" external link without re-querying. */
  relayRequestId?: string
  /** Chain id of the actual outbound. For refunds this is the source chain
   *  (Maya returns the inbound asset on the inbound chain), so the explorer
   *  link must use this — not toChainId. Populated by the Maya midgard
   *  classifier in swap-tracker; falls back to toChainId when absent. */
  outboundChainId?: string
  /** Refund reason from Midgard when status='refunded'. */
  refundReason?: string
}

/** Filter params for getSwapHistory RPC */
export interface SwapHistoryFilter {
  deviceId?: string
  walletId?: string
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

// ── Swap UI mirror (REST → UI control) ────────────────────────────────

export type SwapUiPhase = 'closed' | 'input' | 'quoting' | 'review' | 'approving' | 'signing' | 'broadcasting' | 'submitted'

/** Snapshot of the SwapDialog visible state. Published by the WebView on every
 *  meaningful state change so REST clients (and Bun internals) can observe what
 *  the user sees without scraping the DOM. */
export interface SwapUiState {
  phase: SwapUiPhase
  fromAsset: string | null      // THORChain asset id (e.g. 'BTC.BTC')
  toAsset: string | null
  amount: string                // crypto-denominated user input
  fiatAmount: string
  inputMode: 'crypto' | 'fiat'
  isMax: boolean
  slippageBps: number
  fromAddress: string
  toAddress: string
  useCustomAddress: boolean
  customToAddress: string
  quote: SwapQuote | null
  /** Unsigned tx(s) built ahead of confirm — populated when phase==='review'.
   *  `allowance` describes the current ERC-20 allowance state vs required —
   *  populated for ERC-20 source swaps so the UI can show "approval needed"
   *  vs "✓ already approved" without ambiguity. */
  previewBuild: {
    approveTx?: any
    unsignedTx: any
    allowance?: { current: string; required: string; sufficient: boolean; spender: string; tokenContract: string }
    balance?: { current: string; required: string; sufficient: boolean; tokenContract?: string }
  } | null
  error: string | null
  txid: string | null
}

/** Bun → WebView commands: nudge the SwapDialog the same way a user click
 *  would. The physical KeepKey button press still requires the user — REST
 *  can drive every UI button up to the device prompt, then the user must
 *  confirm on hardware. */
export type SwapUiCommand =
  | { kind: 'open'; fromAsset?: string; toAsset?: string; amount?: string; slippageBps?: number; useCustomAddress?: boolean; customToAddress?: string }
  | { kind: 'set'; fromAsset?: string; toAsset?: string; amount?: string; slippageBps?: number; inputMode?: 'crypto' | 'fiat'; isMax?: boolean; useCustomAddress?: boolean; customToAddress?: string }
  | { kind: 'requote' }
  | { kind: 'advance' }   // input → review (UI navigation only)
  | { kind: 'confirm' }   // click "Confirm Swap" → kicks off executeSwap
  | { kind: 'close' }

// ── Recent Activity types ──────────────────────────────────────────────

export type ActivityType = 'send' | 'receive' | 'swap' | 'sign' | 'message' | 'approve'
export type ActivitySource = 'app' | 'api' | 'scan'

export interface RecentActivity {
  id: string
  deviceId?: string
  walletId?: string
  txid?: string              // blockchain txid (may be absent for sign-only before broadcast)
  chain: string              // chain symbol (BTC, ETH, ATOM, etc.)
  chainId?: string           // internal chain id (bitcoin, ethereum, etc.) — for explorer links
  type: ActivityType
  source: ActivitySource
  to?: string
  amount?: string
  asset?: string             // token symbol if different from chain native
  appName?: string           // for API-originating activities
  status: 'signed' | 'broadcast' | 'completed' | 'refunded' | 'failed'
  swapStatus?: SwapTrackingStatus  // detailed swap lifecycle status (only for type === 'swap')
  // ── Swap-only output side (only set when type === 'swap') ──
  outAmount?: string         // received_output if completed, else quoted_output
  outAsset?: string          // toSymbol
  outChainId?: string        // toChainId — for the output asset's chain badge / explorer
  fromCaip?: string          // CAIP-19 for input asset (icon resolution)
  toCaip?: string            // CAIP-19 for output asset (icon resolution)
  createdAt: number
  // ── On-chain confirmation data (populated by scan, updated on rescan) ──
  confirmations?: number     // current confirmation count (0 = unconfirmed/mempool)
  blockHeight?: number       // block the tx was mined in (0 = unconfirmed)
  fee?: string               // tx fee (human-readable)
}

// RPC types — derived from the single source of truth in rpc-schema.ts
// Import VaultRPCSchema from './rpc-schema' if you need the full Electrobun schema.
// These aliases are for convenience in frontend code that doesn't need Electrobun types.
