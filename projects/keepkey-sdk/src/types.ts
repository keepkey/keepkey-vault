// ── SDK Configuration ───────────────────────────────────────────────
export interface SdkConfig {
  /** Existing API key (from previous pairing). If omitted, SDK will auto-pair. */
  apiKey?: string
  /** Vault REST API base URL. Default: http://localhost:1646 */
  baseUrl?: string
  /** Alias for baseUrl (v1 SDK compat) */
  basePath?: string
  /** Service key (unused, kept for Pioneer SDK compat) */
  serviceKey?: string
  /** Name shown in pairing approval dialog */
  serviceName?: string
  /** Image URL shown in pairing approval dialog */
  serviceImageUrl?: string
  /** v1 SDK compat — pairing info object */
  pairingInfo?: {
    name?: string
    imageUrl?: string
    basePath?: string
    url?: string
  }
}

// ── Device Types ────────────────────────────────────────────────────
export interface DeviceFeatures {
  vendor: string
  major_version: number
  minor_version: number
  patch_version: number
  bootloader_mode: boolean
  device_id: string
  pin_protection: boolean
  passphrase_protection: boolean
  language: string
  label: string
  initialized: boolean
  revision: string
  bootloader_hash: string
  imported: boolean
  pin_cached: boolean
  passphrase_cached: boolean
  policies: Array<{ policy_name: string; enabled: boolean }>
  model: string
  firmware_variant: string
  firmware_hash: string
  no_backup: boolean
  wipe_code_protection: boolean
  auto_lock_delay_ms: number
}

export interface DeviceInfo {
  device_id?: string
  is_active?: boolean
  state: string
  name?: string
  features?: Partial<DeviceFeatures>
}

export interface SignedTx {
  serializedTx?: string
  r?: string
  s?: string
  v?: number
  signature?: string
  serialized?: string
}

export interface AddressResult {
  address: string
}

// ── Address Request Types ───────────────────────────────────────────
export interface AddressRequest {
  address_n: number[]
  coin?: string
  script_type?: string
  show_display?: boolean
}

// ── ETH Types ───────────────────────────────────────────────────────
export interface EthSignTxParams {
  addressNList?: number[]
  address_n_list?: number[]
  from?: string
  to: string
  value: string
  data?: string
  nonce?: string
  gas?: string
  gasLimit?: string
  gasPrice?: string
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
  chainId?: number
}

export interface EthSignTypedDataParams {
  address: string
  typedData: any
}

export interface EthSignMessageParams {
  address: string
  message: string
}

export interface EthVerifyMessageParams {
  address: string
  message: string
  signature: string
}

// ── UTXO Types ──────────────────────────────────────────────────────
export interface BtcSignTxParams {
  coin?: string
  inputs: any[]
  outputs: any[]
  version?: number
  locktime?: number
}

// ── Cosmos-family Types ─────────────────────────────────────────────
export interface CosmosAminoSignParams {
  signDoc: any
  signerAddress: string
}

// ── XRP Types ───────────────────────────────────────────────────────
export interface XrpSignTxParams {
  [key: string]: any
}

// ── BNB Types ───────────────────────────────────────────────────────
export interface BnbSignTxParams {
  [key: string]: any
}

// ── Solana Types ────────────────────────────────────────────────────
export interface SolanaSignTxParams {
  address_n?: number[]
  addressNList?: number[]
  raw_tx: string  // base64-encoded raw transaction
}

// ── Tron Types ─────────────────────────────────────────────────────
export interface TronSignTxParams {
  addressNList: number[]
  from: string
  to: string
  amount: number  // amount in sun (1 TRX = 1,000,000 sun)
  memo?: string
}

// ── TON Types ──────────────────────────────────────────────────────
export interface TonSignTxParams {
  address_n?: number[]
  addressNList?: number[]
  raw_tx: string  // base64 or hex encoded raw transaction
}

// ── Message-signing surface (firmware 7.14.1+) ────────────────────

export interface TronSignMessageParams {
  address_n?: number[]
  addressNList?: number[]
  /** UTF-8 string by default; pass is_text=false to send as hex bytes */
  message: string
  is_text?: boolean
  show_display?: boolean
}

export interface TronMessageSignatureResult {
  /** Base58Check signer address derived from the recovered pubkey */
  address: string
  /** 65-byte recoverable secp256k1 signature (r || s || v), hex-encoded */
  signature: string
}

export interface TronVerifyMessageParams {
  address: string
  /** Hex (with or without 0x) */
  signature: string
  message: string
  is_text?: boolean
}

export interface TronSignTypedHashParams {
  address_n?: number[]
  addressNList?: number[]
  /** 32-byte domainSeparator hash, hex (with or without 0x) */
  domain_separator_hash: string
  /** 32-byte message hash, hex; omit for primaryType=EIP712Domain */
  message_hash?: string
}

export interface TronTypedDataSignatureResult {
  address: string
  /** 65-byte recoverable secp256k1 signature, hex */
  signature: string
}

export interface TonSignMessageParams {
  address_n?: number[]
  addressNList?: number[]
  message: string
  is_text?: boolean
  show_display?: boolean
}

export interface TonMessageSignatureResult {
  /** 32-byte Ed25519 public key, hex */
  publicKey: string
  /** 64-byte Ed25519 signature, hex */
  signature: string
}

export interface SolanaSignOffchainMessageParams {
  address_n?: number[]
  addressNList?: number[]
  message: string
  is_text?: boolean
  /** Spec version. Only 0 currently defined. */
  version?: number
  /** 0 = restricted ASCII, 1 = UTF-8 limited (max 1212 bytes). 2 not supported. */
  message_format?: number
  show_display?: boolean
}

export interface SolanaOffchainMessageSignatureResult {
  /** 32-byte Ed25519 public key, hex */
  publicKey: string
  /** 64-byte Ed25519 signature over the spec envelope, hex */
  signature: string
}

// ── TON build/finalize helpers ─────────────────────────────────────
// These wrap the vault's local v4R2 BOC builder so thin clients
// (browser extension, mobile) can issue a TON transfer without
// embedding a TON lib + toncenter plumbing. Build returns the
// unsigned body hash the device signs; finalize reassembles the
// signed BOC and (by default) broadcasts to TonCenter.

export interface TonBuildTransferParams {
  fromAddress: string
  toAddress: string
  /** Transfer amount in nanoTON, as a decimal string (BigInt-compatible). */
  amountNano: string
  memo?: string
  /** Ed25519 public key hex — only needed for first-time activation. */
  publicKeyHex?: string
}

/**
 * Opaque internal state carried between /ton/build-transfer and
 * /ton/finalize-transfer. Callers should echo this back verbatim;
 * they don't need to inspect it.
 */
export interface TonBuildResult {
  bodyHash: string
  rawTx: string
  seqno: number
  expireAt: number
  toAddress: string
  amountNano: string
  needsDeploy: boolean
  publicKeyHex?: string
  _internal: {
    destWorkchain: number
    destHash: string
    fromWorkchain: number
    fromHash: string
    amountNano: string
    bounce: boolean
    memo?: string
  }
}

export interface TonBuildTransferResult {
  build: TonBuildResult
  bodyHash: string
  rawTx: string
  seqno: number
  expireAt: number
  needsDeploy: boolean
  feeEstimate: string
}

export interface TonFinalizeTransferParams {
  build: TonBuildResult
  /** 64-byte Ed25519 signature, hex-encoded (128 chars). */
  signature: string
  /** Default true. When false, vault returns the signed BOC without broadcasting. */
  broadcast?: boolean
}

export interface TonFinalizeTransferResult {
  boc: string
  txid: string
  broadcasted: boolean
}

// ── Public Key Types ────────────────────────────────────────────────
export interface GetPublicKeyRequest {
  address_n: number[]
  ecdsa_curve_name?: string
  show_display?: boolean
  coin_name?: string
  script_type?: string
}

export interface BatchPubkeysPath {
  address_n: number[]
  script_type?: string
  coin?: string
  type?: 'xpub' | 'address'
  networks?: string[]
  note?: string
}

// ── Apply Settings ──────────────────────────────────────────────────
export interface ApplySettingsParams {
  label?: string
  use_passphrase?: boolean
  autolock_delay_ms?: number
}

// ── System Types ────────────────────────────────────────────────────
export interface HealthResponse {
  ready: boolean
  status: string
  connected: boolean
  device_connected: boolean
  version: string
  uptime: number
  apiVersion: number
  cached_pubkeys: number
}

export interface PairResponse {
  apiKey: string
}

export interface SupportedAsset {
  chain: string
  symbol: string
  coin: string
  networkId: string
  caip: string
  chainFamily: string
}

// ── Chain Data Types (v2 API) ──────────────────────────────────────

export interface PubkeyEntry {
  caip: string
  pubkey: string
}

export interface PortfolioBalancesParams {
  pubkeys: PubkeyEntry[]
}

export interface MarketInfoParams {
  caips: string[]
}

export interface SearchAssetsParams {
  q: string
  limit?: number
}

export interface ListUnspentParams {
  network: string
  xpub: string
}

export interface PubkeyInfoParams {
  network: string
  xpub: string
}

export interface TxHistoryParams {
  queries: Array<{ pubkey: string; caip: string }>
}

export interface BroadcastParams {
  networkId: string
  serialized: string
}

export interface NetworkIdParams {
  networkId: string
}

export interface NetworkAddressParams {
  networkId: string
  address: string
}

export interface TokenDecimalsParams {
  networkId: string
  contractAddress: string
}

export interface StakingParams {
  network: string
  address: string
}

export interface SwapQuoteParams {
  sellAsset: string
  buyAsset: string
  sellAmount: string
  senderAddress: string
  recipientAddress: string
  slippage?: number
}

// ── Sweep Types ────────────────────────────────────────────────────

export interface SweepScanParams {
  accountRange?: [number, number]
  mismatchAccounts?: number
  currentMaxAccount?: number
  higherAccountScanLimit?: number
}

export interface SweepScanStatus {
  id: string
  status: 'scanning' | 'complete' | 'error'
  progress: { current: number; total: number; phase: string }
  startedAt: number
  completedAt?: number
  totalFoundSats: number
  results: SweepResult[]
  error?: string
}

export interface SweepResult {
  path: string
  scriptType: string
  address: string
  category: 'account-key' | 'mismatch' | 'higher-account'
  accountIndex?: number
  balanceSats: number
  utxoCount: number
}

export interface SweepExecuteParams {
  scanId: string
  destinationAddress?: string
  dryRun?: boolean
}

export interface SweepExecuteResult {
  txid?: string
  destination: string
  inputCount: number
  totalSweptSats: number
  fee: number
  outputSats: number
  dryRun?: boolean
  unsignedTx?: any
}
