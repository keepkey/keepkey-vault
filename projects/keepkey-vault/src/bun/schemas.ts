import { z } from 'zod'

// ═══════════════════════════════════════════════════════════════════════
// Shared primitives
// ═══════════════════════════════════════════════════════════════════════

/** BIP32 address path — array of 3-6 hardened/unhardened integers (TON uses 6) */
export const AddressNList = z.array(z.number().int()).min(3).max(6)

/** 0x-prefixed Ethereum address (40 hex chars) */
export const EthAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

/** 0x-prefixed hex string (any length) */
export const HexString = z.string().regex(/^0x[0-9a-fA-F]*$/)

/** BTC input script type enum */
export const BTCInputScriptType = z.enum([
  'p2pkh', 'p2sh-p2wpkh', 'p2wpkh', 'p2sh', 'p2wsh',
])

/** Chain ID — accept string or number, keep as-is (rest-api.ts handles conversion) */
export const ChainIdInput = z.union([z.string(), z.number()])

// ═══════════════════════════════════════════════════════════════════════
// Request schemas
// - Read-only endpoints use .passthrough() for SDK backward compat
// - Signing endpoints use .strip() to drop unknown fields before wallet
// ═══════════════════════════════════════════════════════════════════════

/** Shared address request (9 address endpoints) */
export const AddressRequest = z.object({
  address_n: AddressNList,
  show_display: z.boolean().optional(),
  coin: z.string().optional(),
  script_type: z.string().optional(),
}).passthrough()

/** POST /auth/pair */
export const PairRequest = z.object({
  name: z.string().min(1),
  url: z.string().optional(),
  imageUrl: z.string().optional(),
}).passthrough()

/** POST /eth/sign-transaction */
export const EthSignTransactionRequest = z.object({
  to: z.string(),
  value: z.string().optional(),
  data: z.string().optional(),
  nonce: z.string().optional(),
  gas: z.string().optional(),
  gasLimit: z.string().optional(),
  gasPrice: z.string().optional(),
  gas_price: z.string().optional(),
  maxFeePerGas: z.string().optional(),
  max_fee_per_gas: z.string().optional(),
  maxPriorityFeePerGas: z.string().optional(),
  max_priority_fee_per_gas: z.string().optional(),
  chainId: ChainIdInput.optional(),
  chain_id: ChainIdInput.optional(),
  // Either from or addressNList must be provided
  from: z.string().optional(),
  addressNList: z.array(z.number().int()).optional(),
  address_n_list: z.array(z.number().int()).optional(),
  // EVM clear-signing metadata (firmware 7.14+)
  txMetadata: z.object({
    signedPayload: z.string(),
    keyId: z.number().int().optional(),
  }).optional(),
}).strip().refine(
  d => d.from || d.addressNList || d.address_n_list,
  { message: 'Missing from address or addressNList' },
)

/** POST /eth/sign-typed-data */
export const EthSignTypedDataRequest = z.object({
  address: z.string().min(1),
  typedData: z.any(),
}).strip().refine(
  d => d.typedData !== undefined && d.typedData !== null,
  { message: 'Missing typedData' },
)

/** POST /eth/sign */
export const EthSignRequest = z.object({
  address: z.string().min(1),
  message: HexString,
}).strip()

/** POST /eth/verify */
export const EthVerifyRequest = z.object({
  address: z.string().min(1),
  message: z.string().min(1),
  signature: z.string().min(1),
}).passthrough()

/** POST /utxo/sign-transaction */
export const UtxoSignTransactionRequest = z.object({
  coin: z.string().optional(),
  inputs: z.array(z.any()).min(1),
  outputs: z.array(z.any()).min(1),
  version: z.number().int().optional(),
  locktime: z.number().int().optional(),
}).strip()

/** Cosmos-family amino signDoc */
const CosmosSignDoc = z.object({
  account_number: z.union([z.string(), z.number()]),
  chain_id: z.string(),
  fee: z.any().optional(),
  memo: z.string().optional(),
  msgs: z.array(z.any()).optional(),
  msg: z.array(z.any()).optional(),
  sequence: z.union([z.string(), z.number()]),
}).passthrough()

/** Cosmos-family amino sign request (19 endpoints) */
export const CosmosAminoSignRequest = z.object({
  signerAddress: z.string().min(1),
  signDoc: CosmosSignDoc,
}).strip()

/** POST /xrp/sign-transaction — minimum required fields for RippleSignTx */
export const XrpSignRequest = z.object({
  payment: z.object({
    amount: z.union([z.string(), z.number()]),
    destination: z.string().min(1),
    destinationTag: z.union([z.string(), z.number()]).optional(),
  }).passthrough(),
  sequence: z.union([z.string(), z.number()]),
  fee: z.union([z.string(), z.number()]).optional(),
  flags: z.number().optional(),
  addressNList: z.array(z.number().int()).optional(),
}).strip()

/** POST /solana/sign-transaction — sign a raw Solana transaction */
export const SolanaSignRequest = z.object({
  address_n: z.array(z.number().int()).optional(),
  addressNList: z.array(z.number().int()).optional(),
  raw_tx: z.string().min(1),
}).strip()

/** POST /tron/sign-transaction — sign a raw Tron transaction */
export const TronSignRequest = z.object({
  address_n: z.array(z.number().int()).optional(),
  addressNList: z.array(z.number().int()).optional(),
  raw_tx: z.string().min(1),
  to_address: z.string().optional(),  // enables clear-sign on device
  amount: z.string().optional(),      // amount in SUN — enables clear-sign on device
}).strip()

/** POST /ton/sign-transaction — sign a raw TON transaction */
export const TonSignRequest = z.object({
  address_n: z.array(z.number().int()).optional(),
  addressNList: z.array(z.number().int()).optional(),
  raw_tx: z.string().min(1),
  to_address: z.string().optional(),  // enables clear-sign on device
  amount: z.string().optional(),      // amount in nanoTON — enables clear-sign on device
}).strip()

/**
 * POST /ton/build-transfer — build an unsigned TON v4R2 transfer.
 * Returns the 32-byte body hash (hex) the device should sign plus the
 * internal state the vault needs to assemble the signed BOC after.
 * Clients don't need BOC/Cell awareness — they just pipe the result's
 * `bodyHash` into /ton/sign-transaction and the full build object into
 * /ton/finalize-transfer.
 *
 * `amountNano` is a decimal string (BigInt-compatible) — floats drop
 * precision past ~15 digits and a v4R2 transfer can easily exceed that.
 * `publicKeyHex` is only needed when the wallet isn't activated yet;
 * TON's first tx carries a StateInit that deploys the v4R2 contract.
 */
export const TonBuildTransferRequest = z.object({
  fromAddress: z.string().min(1),
  toAddress: z.string().min(1),
  amountNano: z.string().min(1),
  memo: z.string().optional(),
  publicKeyHex: z.string().optional(),
}).strip()

/**
 * POST /ton/finalize-transfer — assemble the signed BOC from a prior
 * build + device signature and broadcast to TonCenter. Collapses the
 * two-step "assemble then broadcast" flow into one call so clients don't
 * have to re-serialize the build object twice over the wire.
 *
 * `signature` is 64 bytes of Ed25519 output, hex-encoded (matches what
 * /ton/sign-transaction returns).
 */
export const TonFinalizeTransferRequest = z.object({
  // tonBuildResult — shape mirrors TonBuildResult in txbuilder/ton.ts.
  // We don't re-validate every internal field here because the client
  // just echoes back what /ton/build-transfer produced; Zod's passthrough
  // preserves _internal verbatim. Any tampering breaks the cellHash
  // check implicitly during assembly, which is a safer failure mode than
  // a schema diff drifting out of sync with the builder.
  build: z.object({}).passthrough(),
  signature: z.string().regex(/^[0-9a-fA-F]{128}$/, 'signature must be 64-byte hex'),
  broadcast: z.boolean().optional(),
}).strip()

/** POST /solana/sign-message — sign an arbitrary message (firmware type 754) */
export const SolanaSignMessageRequest = z.object({
  address_n: z.array(z.number().int()).optional(),
  addressNList: z.array(z.number().int()).optional(),
  message: z.string().min(1),
  show_display: z.boolean().optional(),
}).strip()


/** POST /system/info/get-public-key */
export const GetPublicKeyRequest = z.object({
  address_n: AddressNList,
  ecdsa_curve_name: z.string().optional(),
  show_display: z.boolean().optional(),
  coin_name: z.string().optional(),
  script_type: z.string().optional(),
}).passthrough()

/** POST /system/apply-settings */
export const ApplySettingsRequest = z.object({
  label: z.string().optional(),
  use_passphrase: z.boolean().optional(),
  autolock_delay_ms: z.number().optional(),
}).passthrough()

/** POST /system/change-pin */
export const ChangePinRequest = z.object({
  remove: z.boolean().optional(),
}).passthrough()

/** POST /system/apply-policies — passthrough (varies per policy) */
export const ApplyPoliciesRequest = z.object({}).passthrough()

/** POST /system/initialize/reset-device */
export const ResetDeviceRequest = z.object({
  word_count: z.number().int().optional(),
  label: z.string().optional(),
  pin_protection: z.boolean().optional(),
  passphrase_protection: z.boolean().optional(),
}).passthrough()

/** POST /system/initialize/recover-device */
export const RecoverDeviceRequest = z.object({
  word_count: z.number().int().optional(),
  label: z.string().optional(),
  pin_protection: z.boolean().optional(),
  passphrase_protection: z.boolean().optional(),
}).passthrough()

/** POST /system/initialize/load-device — passthrough (complex internal type) */
export const LoadDeviceRequest = z.object({}).passthrough()

/** POST /system/recovery/pin */
export const SendPinRequest = z.object({
  pin: z.string().min(1),
}).passthrough()

// ── Zcash Shielded (Orchard) ─────────────────────────────────────────

/** POST /api/zcash/shielded/init */
export const ZcashInitRequest = z.object({
  seed_hex: z.string().optional(),
  from_device: z.boolean().optional(),
  account: z.number().int().min(0).optional(),
}).passthrough()

/** POST /api/zcash/shielded/scan */
export const ZcashScanRequest = z.object({
  start_height: z.number().int().min(0).optional(),
  // Discard the cached note set and re-derive from `start_height` (or the
  // KeepKey release block when omitted). Used by the "Repair wallet" flow.
  full_rescan: z.boolean().optional(),
}).passthrough()

/** POST /api/zcash/shielded/build */
export const ZcashBuildRequest = z.object({
  recipient: z.string().min(1),
  amount: z.number().positive().max(2_100_000_000_000_000),
  account: z.number().int().min(0).optional(),
  memo: z.string().optional(),
}).passthrough()

/** POST /api/zcash/shielded/finalize */
export const ZcashFinalizeRequest = z.object({
  signatures: z.array(z.string().regex(/^[0-9a-fA-F]{128}$/)).min(1),
}).passthrough()

/** POST /api/zcash/shielded/broadcast */
export const ZcashBroadcastRequest = z.object({
  raw_tx: z.string().min(1),
}).passthrough()

/** POST /api/pubkeys/batch */
export const BatchPubkeysRequest = z.object({
  paths: z.array(z.object({
    address_n: z.array(z.number().int()),
    type: z.string().optional(),
    script_type: z.string().optional(),
    coin: z.string().optional(),
    networks: z.array(z.string()).optional(),
    note: z.string().optional(),
  }).passthrough()),
}).passthrough()

// ═══════════════════════════════════════════════════════════════════════
// Response schemas — soft validation (log warning, never block)
// ═══════════════════════════════════════════════════════════════════════

/** ETH sign-transaction response */
export const EthSignTransactionResponse = z.object({
  v: z.union([z.number(), z.string()]),
  r: z.string(),
  s: z.string(),
  serialized: z.string(),
}).passthrough()

/** UTXO sign-transaction response */
export const UtxoSignTransactionResponse = z.object({
  serializedTx: z.string(),
}).passthrough()

/** Cosmos-family amino sign response */
export const CosmosAminoSignResponse = z.object({
  signature: z.any(),
  serialized: z.any().optional(),
  signed: z.any(),
}).passthrough()

/** GET /system/info/get-features response */
export const FeaturesResponse = z.object({
  vendor: z.string().optional(),
  device_id: z.string().optional(),
  label: z.string().nullable().optional(),
  initialized: z.boolean().optional(),
}).passthrough()

/** POST /system/info/get-public-key response */
export const GetPublicKeyResponse = z.object({
  xpub: z.string(),
}).passthrough()

// ═══════════════════════════════════════════════════════════════════════
// REST v2 data schemas (balances, market, UTXOs, tx, network, swap)
// ═══════════════════════════════════════════════════════════════════════

export const PortfolioBalancesRequest = z.object({
  pubkeys: z.array(z.object({ caip: z.string(), pubkey: z.string() })).min(1),
}).passthrough()

export const MarketInfoRequest = z.object({
  caips: z.array(z.string()).min(1),
}).passthrough()

export const SearchAssetsRequest = z.object({
  q: z.string().min(1),
  limit: z.number().int().positive().optional(),
}).passthrough()

export const ListUnspentRequest = z.object({
  network: z.string(),
  xpub: z.string(),
}).passthrough()

export const PubkeyInfoRequest = z.object({
  network: z.string(),
  xpub: z.string(),
}).passthrough()

export const TxHistoryRequest = z.object({
  queries: z.array(z.object({ pubkey: z.string(), caip: z.string() })).min(1),
}).passthrough()

export const BroadcastRequest = z.object({
  networkId: z.string(),
  serialized: z.string(),
}).passthrough()

export const NetworkIdRequest = z.object({
  networkId: z.string(),
}).passthrough()

export const NetworkAddressRequest = z.object({
  networkId: z.string(),
  address: z.string(),
}).passthrough()

export const TokenDecimalsRequest = z.object({
  networkId: z.string(),
  contractAddress: z.string(),
}).passthrough()

export const StakingRequest = z.object({
  network: z.string(),
  address: z.string(),
}).passthrough()

export const SwapQuoteRequest = z.object({
  sellAsset: z.string(),
  buyAsset: z.string(),
  sellAmount: z.string(),
  senderAddress: z.string(),
  recipientAddress: z.string(),
  slippage: z.number().optional(),
}).passthrough()

// ═══════════════════════════════════════════════════════════════════════
// Sweep tool schemas
// ═══════════════════════════════════════════════════════════════════════

export const SweepScanRequest = z.object({
  accountRange: z.tuple([z.number().int().min(0), z.number().int().max(9)]).optional(),
  mismatchAccounts: z.number().int().min(0).max(5).optional(),
  currentMaxAccount: z.number().int().min(0).max(19).optional(),
  higherAccountScanLimit: z.number().int().min(0).max(19).optional(),
}).passthrough()

export const SweepExecuteRequest = z.object({
  scanId: z.string(),
  destinationAddress: z.string().optional(),
  dryRun: z.boolean().optional(),
}).strip()
