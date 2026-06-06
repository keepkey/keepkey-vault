/**
 * Swap Tracker — pull-only state for in-flight swaps.
 *
 * Lifecycle:
 *   1. trackSwap() registers a freshly broadcast swap (in-memory + DB) and
 *      tells Pioneer about it via CreatePendingSwap.
 *   2. The SwapDialog drives polling on-demand via refreshSwap(txid) — there
 *      is no background timer. When the dialog closes, polling stops.
 *   3. Status changes get pushed to the UI via the existing swap-update
 *      RPC message and persisted to SQLite.
 *
 * Pioneer operationIds used:
 *   - CreatePendingSwap  (POST /swaps/pending)
 *   - GetPendingSwap     (GET  /swaps/pending/{txHash})
 */
import type { PendingSwap, SwapTrackingStatus, SwapStatusUpdate, SwapResult, ExecuteSwapParams, SwapQuote, SwapHistoryRecord } from '../shared/types'
import { getPioneer } from './pioneer'
import { withTimeout } from './engine-controller'

const PIONEER_SWAP_TIMEOUT_MS = 30_000
import { insertSwapHistory, updateSwapHistoryStatus, getSwapHistory, getSwapHistoryByTxid, setSwapRelayRequestId } from './db'
import { recordSwap } from './ledger'
import { assetData as discoveryAssetData } from '@pioneer-platform/pioneer-discovery'
import { VAULT_CHAIN_TO_THOR } from '../shared/swap-discovery'
import { extractRelayRequestId } from '../shared/relay-utils'
import { classifySwapOutcome, type MidgardActionsResponse } from './swap/classify'

/** Resolve display data from a CAIP-19. CAIP is the only identifier the swap
 *  layer accepts; symbols / asset names / display names are derived here for
 *  UI rendering and historic records, never used for routing or selection.
 *
 *  Falls back to a CAIP-derived hint for assets pioneer-discovery doesn't
 *  know — better than crashing or silently writing empty strings. */
function resolveDisplayFromCaip(caip: string): { symbol: string; name: string; asset: string } {
  const entry = (discoveryAssetData as Record<string, { symbol?: string; name?: string; chainId?: string }>)[caip]
  const symbol = entry?.symbol || caip.split('/').pop()?.split(':').pop()?.slice(0, 12).toUpperCase() || 'UNKNOWN'
  const name = entry?.name || symbol
  // THORChain-style display string (CHAIN.SYMBOL[-CONTRACT]). Used only for
  // log lines + history rows; vault never parses this back to identify.
  const chainId = entry?.chainId || caip.split('/')[0]
  const thorPrefix = VAULT_CHAIN_TO_THOR[chainIdToVaultId(chainId)] || symbol
  const tokenMatch = caip.match(/\/(erc20|bep20|token):(.+)$/)
  const asset = tokenMatch
    ? `${thorPrefix}.${symbol}-${tokenMatch[2].toUpperCase()}`
    : `${thorPrefix}.${symbol}`
  return { symbol, name, asset }
}

/** Best-effort CAIP-2 → vault chain id (e.g. 'eip155:1' → 'ethereum'). Used
 *  by resolveDisplayFromCaip — VAULT_CHAIN_TO_THOR is keyed on vault ids,
 *  not raw CAIP-2. Safe fallback: return the CAIP-2 itself when unknown. */
function chainIdToVaultId(caip2: string): string {
  // Inline the small mapping rather than importing CHAINS just for this —
  // covers every chain that has a THORChain prefix in our lookup.
  const map: Record<string, string> = {
    'bip122:000000000019d6689c085ae165831e93': 'bitcoin',
    'bip122:000000000000000000651ef99cb9fcbe': 'bitcoincash',
    'bip122:00000000001a91e3dace36e2be3bf030': 'dogecoin',
    'bip122:12a765e31ffd4059bada1e25190f6e98': 'litecoin',
    'bip122:000007d91d1254d60e2dd1ae58038307': 'dash',
    'eip155:1': 'ethereum',
    'eip155:10': 'optimism',
    'eip155:56': 'bsc',
    'eip155:137': 'polygon',
    'eip155:8453': 'base',
    'eip155:42161': 'arbitrum',
    'eip155:43114': 'avalanche',
    'cosmos:cosmoshub-4': 'cosmos',
    'cosmos:thorchain-mainnet-v1': 'thorchain',
    'cosmos:mayachain-mainnet-v1': 'mayachain',
    'cosmos:osmosis-1': 'osmosis',
    'tron:0x2b6653dc': 'tron',
    'tron:27Lqcw': 'tron',
    'ton:-239': 'ton',
    'ripple:0': 'ripple',
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'solana',
  }
  return map[caip2] || caip2
}
import {
  isTerminalSwapStatus,
  mapRelayExecutionStatus,
  relayOutboundTxid,
  shouldApplyRelayStatus,
  type RelayExecutionStatus,
} from '../shared/relay-status'

const TAG = '[swap-tracker]'

/** Debug log — gated behind SWAP_DEBUG=1 (env) or localStorage `swap.debug=1`.
 *  Used in place of console.log for high-volume per-swap chatter. console.warn /
 *  console.error are deliberately *not* gated — those still ship in prod. */
const SWAP_DEBUG = ((): boolean => {
  try {
    if (typeof process !== 'undefined' && process.env?.SWAP_DEBUG === '1') return true
    if (typeof localStorage !== 'undefined' && localStorage.getItem('swap.debug') === '1') return true
  } catch { /* noop */ }
  return false
})()
const swapLog = (...args: any[]): void => { if (SWAP_DEBUG) console.log(...args) }

/** Infer a reasonable confirmation count from persisted status when the DB lacks a confirmations column.
 *  These are conservative lower-bounds — the next poll will replace them with real data. */
export function inferConfirmationsFromStatus(status: SwapTrackingStatus): number {
  switch (status) {
    case 'pending':           return 0
    case 'confirming':        return 1
    case 'output_detected':   return 3  // inbound fully confirmed, output seen
    case 'output_confirming': return 3
    case 'output_confirmed':  return 3
    case 'completed':         return 3
    default:                  return 0
  }
}

// ── In-memory swap registry ─────────────────────────────────────────

const pendingSwaps = new Map<string, PendingSwap>()
// PRIVACY: txids that must not be persisted to DB (passphrase wallet swaps)
const noPersistSwaps = new Set<string>()
// txids whose registered Pioneer row has been verified (via GetPendingSwap)
// to carry our relayRequestId. Used to stop the lazy re-registration loop —
// without this, every refreshSwap retries CreatePendingSwap forever.
const relayPioneerVerified = new Set<string>()
// Per-txid count of register-relay-id attempts. Caps the retry loop at
// MAX_RELAY_REGISTER_ATTEMPTS so a permanent Pioneer-side rejection (e.g.
// 409 on duplicate txHash with no upsert) doesn't spin forever each time
// the user reopens the dialog. Once the cap is hit, we log loudly and stop
// — the user-visible tracker link still works (it's local), only Pioneer's
// monitor side stays missing the id.
const relayRegisterAttempts = new Map<string, number>()
const MAX_RELAY_REGISTER_ATTEMPTS = 5
// Per-txid count of re-registration attempts for swaps Pioneer reports as
// not_found — i.e. the initial CreatePendingSwap never landed (transient 400/500
// at broadcast time, or the process restarted before the in-flight call
// finished). Driven off the not_found signal in refreshSwap rather than an
// in-memory "registration failed" flag, so it survives a Vault restart: a
// rehydrated swap that's still not_found in Pioneer gets re-registered.
// Swapper-agnostic — covers THORChain/Maya memo swaps the relay-id backfill
// above never touches. NEAR Intents is excluded (it stays not_found by design;
// 1Click is authoritative). An entry is created only for swaps that actually hit
// not_found and is cleared the moment Pioneer returns a real row, so the map
// doesn't accumulate one entry per swap.
const pioneerRegistrationAttempts = new Map<string, number>()
const MAX_PIONEER_REGISTER_ATTEMPTS = 10
let sendMessage: ((msg: string, data: any) => void) | null = null
let pioneerVerified = false
let initPromise: Promise<void> | null = null
let getActiveDeviceId: () => string | undefined = () => undefined
let getActiveWalletId: () => string | undefined = () => undefined
const rehydratedWalletIds = new Set<string>()

// Required Pioneer SDK methods — app MUST NOT start without these
const REQUIRED_METHODS = ['CreatePendingSwap', 'GetPendingSwap'] as const

// ── Public API ──────────────────────────────────────────────────────

/** Check if the tracker has been initialized with a message sender */
export function isTrackerInitialized(): boolean {
  return sendMessage !== null
}

function rehydrateActiveSwaps(deviceId?: string, walletId?: string): void {
  const scopeId = walletId || deviceId
  if (!scopeId || rehydratedWalletIds.has(scopeId)) return

  try {
    const activeStatuses: SwapTrackingStatus[] = ['pending', 'confirming', 'output_detected', 'output_confirming', 'output_confirmed']
    for (const status of activeStatuses) {
      const records = getSwapHistory({ status, limit: 50, deviceId, walletId })
      for (const r of records) {
        if (pendingSwaps.has(r.txid)) continue
        const swap: PendingSwap = {
          deviceId: r.deviceId,
          walletId: r.walletId,
          txid: r.txid,
          fromAsset: r.fromAsset,
          toAsset: r.toAsset,
          fromSymbol: r.fromSymbol,
          toSymbol: r.toSymbol,
          fromChainId: r.fromChainId,
          toChainId: r.toChainId,
          fromCaip: r.fromCaip,
          toCaip: r.toCaip,
          fromAmount: r.fromAmount,
          expectedOutput: r.quotedOutput,
          receivedOutput: r.receivedOutput,
          memo: r.memo,
          inboundAddress: r.inboundAddress,
          router: r.router,
          integration: r.integration,
          swapper: r.swapper,
          status: r.status,
          confirmations: inferConfirmationsFromStatus(r.status),
          outboundTxid: r.outboundTxid,
          outboundChainId: r.outboundChainId,
          refundReason: r.refundReason,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          completedAt: r.completedAt,
          estimatedTime: r.estimatedTimeSeconds,
          slippageBps: r.slippageBps,
          relayRequestId: r.relayRequestId,
          nearTxHash: r.nearTxHash,
          inboundBlockNumber: r.inboundBlockNumber,
          inboundBlockHash: r.inboundBlockHash,
          inboundGasUsed: r.inboundGasUsed,
          inboundEffectiveGasPrice: r.inboundEffectiveGasPrice,
          inboundConfirmedAt: r.inboundConfirmedAt,
          errorActionable: r.errorActionable,
          errorElapsedMinutes: r.errorElapsedMinutes,
        }
        pendingSwaps.set(r.txid, swap)
      }
    }
    rehydratedWalletIds.add(scopeId)
    if (pendingSwaps.size > 0) {
      swapLog(`${TAG} Rehydrated active swap(s) for scope ${scopeId}`)
    }
  } catch (e: any) {
    console.warn(`${TAG} Failed to rehydrate swaps from SQLite: ${e.message}`)
  }
}

/** Initialize the tracker — verifies Pioneer SDK has required methods. Idempotent: safe to call multiple times. */
export async function initSwapTracker(messageSender: (msg: string, data: any) => void, opts?: { getDeviceId?: () => string | undefined; getWalletId?: () => string | undefined }): Promise<void> {
  // Always update the message sender (supports re-init after failure)
  sendMessage = messageSender
  if (opts?.getDeviceId) getActiveDeviceId = opts.getDeviceId
  if (opts?.getWalletId) getActiveWalletId = opts.getWalletId

  // If already verified, just update the sender and return
  if (pioneerVerified) {
    rehydrateActiveSwaps(getActiveDeviceId(), getActiveWalletId())
    return
  }

  // Deduplicate concurrent init calls
  if (initPromise) return initPromise
  initPromise = (async () => {
    // FAIL FAST: Verify Pioneer SDK exposes the swap tracking methods
    const pioneer = await getPioneer()
    const missing: string[] = []
    for (const method of REQUIRED_METHODS) {
      if (typeof pioneer[method] !== 'function') {
        missing.push(method)
      }
    }
    if (missing.length > 0) {
      const available = Object.keys(pioneer).filter(k => typeof pioneer[k] === 'function')
      console.error(`${TAG} FATAL: Pioneer SDK missing required methods: ${missing.join(', ')}`)
      console.error(`${TAG} Available methods: ${available.join(', ')}`)
      throw new Error(`Pioneer SDK missing swap tracking methods: ${missing.join(', ')}. Cannot track swaps.`)
    }

    pioneerVerified = true
    swapLog(`${TAG} Tracker initialized — Pioneer SDK verified (${REQUIRED_METHODS.join(', ')})`)
  })()

  try {
    await initPromise
  } finally {
    initPromise = null
  }

  // Rehydrate active swaps for the connected device only. No polling at boot —
  // refreshSwap() drives status updates only when the user opens a swap dialog.
  rehydrateActiveSwaps(getActiveDeviceId(), getActiveWalletId())
}

/** Register a newly broadcast swap for tracking.
 *  @param opts.skipPersist - When true, skip DB writes (PRIVACY: passphrase wallets). */
export function trackSwap(
  result: SwapResult,
  params: ExecuteSwapParams,
  quote: SwapQuote,
  opts?: { skipPersist?: boolean; deviceId?: string; walletId?: string },
): void {
  const now = Date.now()
  const deviceId = opts?.deviceId
  const walletId = opts?.walletId
  // CAIP is the only identifier the caller provides. Display strings
  // (symbol, name, THORChain-style asset) are derived here so UI/history
  // can render without a Pioneer round-trip — never used for routing.
  const fromDisplay = resolveDisplayFromCaip(params.fromCaip)
  const toDisplay = resolveDisplayFromCaip(params.toCaip)

  // Relay deposits embed the request id as the trailing bytes32 of the
  // prebuilt calldata. Extract once at sign-time so the resume path / tracker
  // link doesn't need a round-trip to api.relay.link for new swaps.
  const relayRequestId = extractRelayRequestId(params.relayTx?.data)

  const swap: PendingSwap = {
    deviceId,
    walletId,
    txid: result.txid,
    fromAsset: fromDisplay.asset,
    toAsset: toDisplay.asset,
    fromSymbol: fromDisplay.symbol,
    toSymbol: toDisplay.symbol,
    fromChainId: params.fromChainId,
    toChainId: params.toChainId,
    fromCaip: params.fromCaip,
    toCaip: params.toCaip,
    fromAmount: params.amount,
    expectedOutput: params.expectedOutput,
    memo: params.memo,
    inboundAddress: params.inboundAddress,
    router: params.router,
    integration: quote.integration || 'thorchain',
    swapper: quote.swapper,
    status: 'pending',
    confirmations: 0,
    createdAt: now,
    updatedAt: now,
    estimatedTime: quote.estimatedTime,
    slippageBps: quote.slippageBps,
    relayRequestId,
    nearIntentsDepositAddress: quote.nearIntentsDepositAddress,
    fromAmountBaseUnits: result.fromAmountBaseUnits,
  }

  pendingSwaps.set(result.txid, swap)
  swapLog(`${TAG} Tracking swap: ${result.txid} (${swap.fromSymbol} → ${swap.toSymbol})`)

  // Persist to SQLite — full lifecycle record. Asset string + symbols are
  // derived display fields, populated from the CAIP. CAIP is canonical.
  const historyRecord: SwapHistoryRecord = {
    id: crypto.randomUUID(),
    deviceId,
    walletId,
    txid: result.txid,
    fromAsset: fromDisplay.asset,
    toAsset: toDisplay.asset,
    fromSymbol: fromDisplay.symbol,
    toSymbol: toDisplay.symbol,
    fromChainId: params.fromChainId,
    toChainId: params.toChainId,
    fromCaip: params.fromCaip,
    toCaip: params.toCaip,
    fromAmount: params.amount,
    quotedOutput: quote.expectedOutput || params.expectedOutput,
    minimumOutput: quote.minimumOutput || '0',
    slippageBps: quote.slippageBps || 300,
    feeBps: quote.fees?.totalBps || 0,
    feeOutbound: quote.fees?.outbound || '0',
    integration: quote.integration || 'thorchain',
    swapper: quote.swapper,
    memo: params.memo,
    inboundAddress: params.inboundAddress,
    router: params.router,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    estimatedTimeSeconds: quote.estimatedTime || 0,
    approvalTxid: result.approvalTxid,
    relayRequestId,
  }
  // PRIVACY: Skip DB write for passphrase wallets — swap still tracked in-memory for UI.
  if (opts?.skipPersist) {
    noPersistSwaps.add(result.txid)
  } else {
    insertSwapHistory(historyRecord)
  }

  // Push immediate update to frontend FIRST (user sees "pending" instantly)
  pushUpdate(swap)

  // Register with Pioneer API — log errors but don't block (server processes async).
  // A failure here isn't fatal: refreshSwap re-registers (bounded) whenever it
  // sees Pioneer still has no row for an active swap, which also covers a restart
  // that drops the in-flight call.
  registerWithPioneer(swap).catch((e) => {
    console.error(`${TAG} Pioneer registration FAILED for ${result.txid}: ${e.message}`)
    console.error(`${TAG} Stack: ${e.stack}`)
  })

  // Polling is on-demand — the UI calls refreshSwap(txid) once the dialog
  // mounts in the 'submitted' phase.
}

/** Get all pending swaps (for getPendingSwaps RPC) */
export function getPendingSwaps(deviceId?: string, walletId?: string): PendingSwap[] {
  rehydrateActiveSwaps(deviceId, walletId)
  return Array.from(pendingSwaps.values())
    .filter(s => walletId ? s.walletId === walletId : !deviceId || s.deviceId === deviceId)
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** Age out pending swaps that have been stuck for more than 24 hours.
 *  Called at startup and periodically so old test/failed swaps don't
 *  accumulate as permanent dashboard banners. */
export function cleanupStalePendingSwaps(): void {
  const now = Date.now()
  const STALE_MS = 24 * 60 * 60 * 1000
  try {
    const records = getSwapHistory({ status: 'pending', limit: 100 })
    for (const r of records) {
      if (now - r.createdAt < STALE_MS) continue
      updateSwapHistoryStatus(r.txid, 'failed', {
        deviceId: r.deviceId,
        walletId: r.walletId,
        error: 'Timed out — check explorer',
      })
      pendingSwaps.delete(r.txid)
    }
  } catch (e: any) {
    console.warn(`${TAG} cleanupStalePendingSwaps failed: ${e.message}`)
  }
}

/** Dismiss a swap from the tracker (user clicked dismiss) */
export function dismissSwap(txid: string): void {
  pendingSwaps.delete(txid)
}

// ── Pioneer REST registration ───────────────────────────────────────

// Pioneer's CreatePendingSwap validator only accepts these integration values
// (see pioneer-server's swagger). Vault internally uses the module-level names
// returned by /api/v1/quote (e.g. "shapeshiftSwap"), so map to the validator
// enum here. Unknown values fall through unchanged — Pioneer will 400 and the
// log will show the mismatch so we can extend this map.
const PIONEER_INTEGRATION_ALIAS: Record<string, string> = {
  shapeshiftSwap: 'shapeshift',
  nearIntents: 'shapeshift',
}

async function registerWithPioneer(swap: PendingSwap): Promise<void> {
  const pioneer = await getPioneer()

  // CAIP comes straight from the swap record — no asset-string round-trip
  // needed. PendingSwap.fromCaip is populated by trackSwap() from the picker's
  // selection and is the canonical identifier Pioneer's tracker keys on.
  const sellCaip = swap.fromCaip
  const buyCaip = swap.toCaip
  if (!sellCaip || !buyCaip) {
    throw new Error(`registerWithPioneer: missing CAIP (from=${sellCaip}, to=${buyCaip}) for ${swap.txid}`)
  }

  const integration = PIONEER_INTEGRATION_ALIAS[swap.integration] || swap.integration

  // CAIP-2 is the first segment of the CAIP-19 ("eip155:8453" from "eip155:8453/erc20:0x...").
  // Using it directly avoids the legacy chain-id string bug (networkId: "base" → monitor falls
  // back to Ethereum mainnet RPC and never finds the Base tx).
  const sellNetworkId = sellCaip.split('/')[0]
  const buyNetworkId  = buyCaip.split('/')[0]

  // For NEAR Intents ERC-20, the address that actually receives the funds is the 1Click
  // depositAddress — NOT the token contract stored in inboundAddress.
  const sellAddress = swap.nearIntentsDepositAddress || swap.inboundAddress || ''

  const body: Record<string, any> = {
    txHash: swap.txid,
    addresses: [],
    sellAsset: {
      caip: sellCaip,
      symbol: swap.fromSymbol,
      amount: swap.fromAmount,
      amountBaseUnits: swap.fromAmountBaseUnits || swap.fromAmount,
      address: sellAddress,
      networkId: sellNetworkId,
    },
    buyAsset: {
      caip: buyCaip,
      symbol: swap.toSymbol,
      amount: swap.expectedOutput,
      amountBaseUnits: swap.expectedOutput,
      address: buyCaip.startsWith('eip155:') && swap.walletId?.includes(':')
        ? swap.walletId.slice(swap.walletId.indexOf(':') + 1)
        : '',
      networkId: buyNetworkId,
    },
    quote: {
      id: swap.txid,
      integration,
      expectedAmountOut: swap.expectedOutput,
      minimumAmountOut: swap.expectedOutput,
      slippage: 3,
      fees: { affiliate: '0', protocol: '0', network: '0' },
      memo: swap.memo,
    },
    integration,
    swapper: swap.swapper,
  }
  // Forward the Relay request id when we have one. Pioneer's swap-monitor
  // (checkRelaySwap) keys on relayData.requestId; without it Pioneer falls
  // back to a confirmation-only watcher that never reaches a terminal status
  // for Relay's off-chain settlement model.
  if (swap.relayRequestId) {
    body.relayData = { requestId: swap.relayRequestId }
  }
  if (swap.swapper === 'NEAR Intents' && sellAddress) {
    body.nearIntentsData = { depositAddress: sellAddress }
  }
  swapLog(`${TAG} CreatePendingSwap request:`, JSON.stringify({ txHash: body.txHash, sellCaip: body.sellAsset.caip, buyCaip: body.buyAsset.caip, integration: body.integration, swapper: body.swapper }))

  let resp: any
  try {
    resp = await withTimeout(pioneer.CreatePendingSwap(body), PIONEER_SWAP_TIMEOUT_MS, 'CreatePendingSwap')
  } catch (e: any) {
    // Surface the server's response body — without this a 400/500 only logs a
    // bare message, leaving no way to tell a load spike from a schema rejection.
    const responseBody = e?.response?.body || e?.response?.data || e?.response?.text || e?.body || e?.data
    console.error(`${TAG} CreatePendingSwap HTTP error: ${e?.status || e?.statusCode || 'unknown'} ${e?.message}`)
    if (responseBody) console.error(`${TAG} Server response:`, typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody))
    throw e
  }
  swapLog(`${TAG} CreatePendingSwap response:`, JSON.stringify(resp?.data || resp))
  swapLog(`${TAG} Registered swap with Pioneer: ${swap.txid}`)
}

// ── On-demand Pioneer fetch ────────────────────────────────────────

/** Apply remote swap data to local swap, push updates if changed.
 *
 * If `swap.midgardClassified` is true, Pioneer's status is non-authoritative
 * (it cannot tell a refund apart from a completion) and gets ignored — we
 * still consume confirmations / timing / fees from Pioneer, but status is
 * frozen at whatever Midgard ruled. Without this gate the two sources
 * ping-pong on every refresh and burn through Pioneer rate limits. */
function applyRemoteSwapData(swap: PendingSwap, remoteSwap: any): void {
  // Pioneer's mapped status only takes effect when Midgard hasn't ruled yet.
  const pioneerStatus = mapPioneerStatus(remoteSwap.status)
  const ignoreNonFinalPioneer = isTerminalSwapStatus(swap.status) && !isTerminalSwapStatus(pioneerStatus)
  // Pioneer maps refunds → 'completed' and cannot be trusted to override a locally
  // confirmed refund (verified on-chain or via the swap-monitor's eth_getBalance check).
  const localRefundOverridesPioneer = swap.status === 'refunded' && pioneerStatus === 'completed'
  const newStatus = swap.midgardClassified
    ? swap.status
    : (ignoreNonFinalPioneer || localRefundOverridesPioneer)
      ? swap.status
      : pioneerStatus
  const confirmations = ignoreNonFinalPioneer ? swap.confirmations : (remoteSwap.confirmations ?? swap.confirmations)
  const outboundConfirmations = remoteSwap.outboundConfirmations
  const outboundRequiredConfirmations = remoteSwap.outboundRequiredConfirmations
  const outboundTxid = remoteSwap.thorchainData?.outboundTxHash
    || remoteSwap.mayachainData?.outboundTxHash
    || remoteSwap.relayData?.outTxHashes?.[0]
  // Pioneer surfaces the detected underlying protocol in `details.protocol.protocol`.
  // If the quote-time parse missed `swapper` (common for aggregator routes where
  // ShapeShift's response shape varies), this is the authoritative value.
  //
  // EXCEPTION: native vault routes (mayachain, thorchain) ARE the swapper —
  // there's no underlying aggregator to discover. Maya forked THORChain's code
  // and Pioneer's `details.protocol.protocol` reports "thorchain" even for
  // Maya pools, which would mis-render as "THORChain via Maya" in the badge.
  // Suppress the override so the badge falls back to `integration`.
  const isNativeVaultRoute = swap.integration === 'mayachain' || swap.integration === 'thorchain'
  // NEAR Intents: Pioneer misidentifies BTC deposits with no memo as THORChain
  // (both are memo-less UTXO sends). Block the swapper adoption so 'NEAR Intents'
  // is not overwritten with 'thorchain' in the DB and UI.
  const pioneerMisidentifiedAsThorchain = isNearIntentsSwap(swap)
    && (remoteSwap.details?.protocol?.protocol || '').toLowerCase() === 'thorchain'
  const detectedSwapper: string | undefined = (isNativeVaultRoute || pioneerMisidentifiedAsThorchain)
    ? undefined
    : (remoteSwap.details?.protocol?.protocol || remoteSwap.swapper || undefined)
  const errorMsg = remoteSwap.error?.userMessage || remoteSwap.error?.message
    || (remoteSwap.error ? String(remoteSwap.error) : undefined)
  const timeEstimate = remoteSwap.timeEstimate

  // ── Inbound (input tx) on-chain location + timing ──
  // Pioneer records where the INPUT tx landed under `blockchainTxData`, the
  // confirm time under `confirmedAt`, and richer failure guidance under
  // `error.actionable` / `error.context`. All best-effort: blockchainTxData is
  // null on many swaps, blockHash/effectiveGasPrice are frequently null even
  // when present, and gasUsed is vbytes (not gas) for non-EVM inputs — so the
  // gas fields are only adopted for EVM inputs.
  const isEvmInput = !!swap.fromCaip?.startsWith('eip155:')
  const btd = remoteSwap.blockchainTxData || undefined
  // Blockchair (Pioneer's UTXO backend) reports `block_id: -1` for txs still in
  // the mempool, and some backends use 0. A real block height is >= 1, so anything
  // non-positive means "not yet mined" — drop it rather than render "Block #-1".
  const inboundBlockNumber: number | undefined = (btd?.blockNumber != null && Number.isFinite(Number(btd.blockNumber)) && Number(btd.blockNumber) > 0)
    ? Number(btd.blockNumber)
    : undefined
  const inboundBlockHash: string | undefined = btd?.blockHash || undefined
  const inboundGasUsed: string | undefined = (isEvmInput && btd?.gasUsed != null) ? String(btd.gasUsed) : undefined
  const inboundEffectiveGasPrice: string | undefined = (isEvmInput && btd?.effectiveGasPrice != null) ? String(btd.effectiveGasPrice) : undefined
  const confirmedAtMs: number | undefined = (() => {
    if (!remoteSwap.confirmedAt) return undefined
    const ms = new Date(remoteSwap.confirmedAt).getTime()
    return Number.isFinite(ms) ? ms : undefined
  })()
  const errorActionable: string | undefined = remoteSwap.error?.actionable || undefined
  const errorElapsedMinutes: number | undefined = (typeof remoteSwap.error?.context?.elapsedMinutes === 'number')
    ? remoteSwap.error.context.elapsedMinutes
    : undefined

  // When Midgard has ruled, Pioneer's outboundTxid is also non-authoritative —
  // Pioneer may carry a stale "expected outbound" hash that disagrees with
  // the actual on-chain refund/delivery. Locking it here prevents the same
  // ping-pong loop status had.
  const acceptOutboundTxid = !swap.midgardClassified

  // Stale-swapper cleanup MUST be evaluated as a "change" before the changed
  // boolean is computed. Otherwise the cleanup runs but no push/persist
  // fires, leaving the DB record (and the resume-render path that seeds
  // liveSwapper from it) stuck on "thorchain" forever.
  const shouldClearSwapper = isNativeVaultRoute && !!swap.swapper

  // New inbound/timing data can arrive while status & confirmations hold steady
  // (e.g. blockNumber lands on an already-'confirming' swap), so it must count
  // as a change in its own right or the push/persist below never fires.
  const inboundDataChanged =
    (inboundBlockNumber !== undefined && inboundBlockNumber !== swap.inboundBlockNumber) ||
    (!!inboundBlockHash && inboundBlockHash !== swap.inboundBlockHash) ||
    (!!inboundGasUsed && inboundGasUsed !== swap.inboundGasUsed) ||
    (!!inboundEffectiveGasPrice && inboundEffectiveGasPrice !== swap.inboundEffectiveGasPrice) ||
    (confirmedAtMs !== undefined && confirmedAtMs !== swap.inboundConfirmedAt) ||
    (!!errorActionable && errorActionable !== swap.errorActionable) ||
    (errorElapsedMinutes !== undefined && errorElapsedMinutes !== swap.errorElapsedMinutes)

  const changed =
    newStatus !== swap.status ||
    confirmations !== swap.confirmations ||
    (outboundConfirmations !== undefined && outboundConfirmations !== swap.outboundConfirmations) ||
    (acceptOutboundTxid && outboundTxid && outboundTxid !== swap.outboundTxid) ||
    (detectedSwapper && detectedSwapper !== swap.swapper) ||
    shouldClearSwapper ||
    inboundDataChanged

  if (changed) {
    swap.status = newStatus
    swap.updatedAt = Date.now()
    swap.confirmations = confirmations
    if (outboundConfirmations !== undefined) swap.outboundConfirmations = outboundConfirmations
    if (outboundRequiredConfirmations !== undefined) swap.outboundRequiredConfirmations = outboundRequiredConfirmations
    if (acceptOutboundTxid && outboundTxid) swap.outboundTxid = outboundTxid
    if (shouldClearSwapper) swap.swapper = undefined
    if (errorMsg) swap.error = errorMsg
    if (detectedSwapper && !swap.swapper) swap.swapper = detectedSwapper

    // Inbound location + timing — only overwrite when the poll carries a value
    // (a later rescan can drop blockHash/effectiveGasPrice; don't let it wipe
    // what an earlier poll already established).
    if (inboundBlockNumber !== undefined) swap.inboundBlockNumber = inboundBlockNumber
    if (inboundBlockHash) swap.inboundBlockHash = inboundBlockHash
    if (inboundGasUsed) swap.inboundGasUsed = inboundGasUsed
    if (inboundEffectiveGasPrice) swap.inboundEffectiveGasPrice = inboundEffectiveGasPrice
    if (confirmedAtMs !== undefined) swap.inboundConfirmedAt = confirmedAtMs
    if (errorActionable) swap.errorActionable = errorActionable
    if (errorElapsedMinutes !== undefined) swap.errorElapsedMinutes = errorElapsedMinutes

    if (timeEstimate?.total_swap_seconds && timeEstimate.total_swap_seconds > 0) {
      swap.estimatedTime = timeEstimate.total_swap_seconds
    }

    let receivedOutput: string | undefined = (remoteSwap.buyAsset?.amount && parseFloat(remoteSwap.buyAsset.amount) > 0)
      ? remoteSwap.buyAsset.amount
      : undefined
    // Same 100× correction as parseQuoteResponse: Pioneer uses 8 decimal places
    // for CACAO (should be 10). Guard on exact CAIP so Maya-routed ETH/ARB are
    // not affected.
    const CACAO_CAIP = 'cosmos:mayachain-mainnet-v1/slip44:931'
    if (receivedOutput && swap.toCaip === CACAO_CAIP) {
      const corrected = parseFloat(receivedOutput) / 100
      if (corrected > 0) receivedOutput = corrected.toFixed(10).replace(/\.?0+$/, '')
    }
    if (receivedOutput) {
      swap.receivedOutput = receivedOutput
      // Backward-compat: display still reads expectedOutput in some places.
      swap.expectedOutput = receivedOutput
    }

    swapLog(`${TAG} Status change: ${swap.txid} → ${newStatus} (confirmations=${confirmations}, outbound=${outboundConfirmations || 0}/${outboundRequiredConfirmations || '?'}, outTxid=${outboundTxid || 'none'})`)

    // Persist status change to SQLite (skip for passphrase wallet swaps).
    // Use `swap.outboundTxid` (post-lock truth) NOT the local `outboundTxid`
    // extracted from Pioneer — when midgardClassified is set Pioneer's view
    // is stale and would otherwise overwrite the DB on the next refresh.
    // Same rationale for swapper: pass `null` (not undefined) when we just
    // cleared a stale value so the DB column actually clears.
    const isFinal = newStatus === 'completed' || newStatus === 'failed' || newStatus === 'refunded'
    const now = Date.now()
    if (!noPersistSwaps.has(swap.txid)) updateSwapHistoryStatus(swap.txid, newStatus, {
      deviceId: swap.deviceId,
      walletId: swap.walletId,
      outboundTxid: swap.outboundTxid || undefined,
      error: errorMsg || undefined,
      receivedOutput,
      swapper: shouldClearSwapper ? null : swap.swapper,
      completedAt: isFinal ? now : undefined,
      actualTimeSeconds: isFinal ? Math.round((now - swap.createdAt) / 1000) : undefined,
      inboundBlockNumber,
      inboundBlockHash,
      inboundGasUsed,
      inboundEffectiveGasPrice,
      inboundConfirmedAt: confirmedAtMs,
      errorActionable,
      errorElapsedMinutes,
    })

    pushUpdate(swap)

    if (isFinal) {
      if (newStatus === 'completed' && swap.deviceId) {
        try {
          recordSwap({
            deviceId: swap.deviceId,
            txid: swap.txid,
            fromAsset: swap.fromSymbol,
            fromChainId: swap.fromChainId,
            fromAmount: parseFloat(swap.fromAmount) || 0,
            toAsset: swap.toSymbol,
            toChainId: swap.toChainId,
            toAmount: parseFloat(swap.receivedOutput || swap.expectedOutput) || 0,
          })
        } catch { /* non-fatal */ }
      }
      pushComplete(swap)
    }
  }
}

/** Build an in-memory PendingSwap from a persisted history row. Pure read —
 *  no side effects. Use this anywhere the caller wants to inspect a stored
 *  swap without "reactivating" it in the live tracker registry. */
function readSwapFromDb(txid: string, deviceId?: string, walletId?: string): PendingSwap | null {
  const r = getSwapHistoryByTxid(txid, deviceId, walletId)
  if (!r) return null
  return {
    deviceId: r.deviceId,
    walletId: r.walletId,
    txid: r.txid,
    fromAsset: r.fromAsset, toAsset: r.toAsset,
    fromSymbol: r.fromSymbol, toSymbol: r.toSymbol,
    fromChainId: r.fromChainId, toChainId: r.toChainId,
    fromCaip: r.fromCaip, toCaip: r.toCaip,
    fromAmount: r.fromAmount,
    expectedOutput: r.receivedOutput || r.quotedOutput,
    receivedOutput: r.receivedOutput,
    memo: r.memo, inboundAddress: r.inboundAddress, router: r.router,
    integration: r.integration, swapper: r.swapper,
    status: r.status, confirmations: inferConfirmationsFromStatus(r.status),
    outboundTxid: r.outboundTxid,
    createdAt: r.createdAt, updatedAt: r.updatedAt, completedAt: r.completedAt,
    estimatedTime: r.estimatedTimeSeconds,
    slippageBps: r.slippageBps,
    error: r.error,
    relayRequestId: r.relayRequestId,
    // Carry the classifier output across resumes so the UI's explorer link
    // and refund reason render correctly without waiting for the next poll.
    // Implies `midgardClassified=true` if either is set, locking Pioneer's
    // status mapping out from regression on the first refresh.
    outboundChainId: r.outboundChainId,
    refundReason: r.refundReason,
    nearTxHash: r.nearTxHash,
    inboundBlockNumber: r.inboundBlockNumber,
    inboundBlockHash: r.inboundBlockHash,
    inboundGasUsed: r.inboundGasUsed,
    inboundEffectiveGasPrice: r.inboundEffectiveGasPrice,
    inboundConfirmedAt: r.inboundConfirmedAt,
    errorActionable: r.errorActionable,
    errorElapsedMinutes: r.errorElapsedMinutes,
    midgardClassified: !!(r.outboundChainId || r.refundReason),
  }
}

/** Hydrate the in-memory swap from the persisted record AND register it in
 *  the active tracker registry. Use only on paths that intend to refresh /
 *  push updates for the swap going forward (refreshSwap, getPendingSwaps).
 *  For diagnostic / read-only paths, call readSwapFromDb directly so the
 *  tracker registry isn't polluted by an idle history lookup. */
function hydrateFromDb(txid: string, deviceId?: string, walletId?: string): PendingSwap | null {
  const swap = readSwapFromDb(txid, deviceId, walletId)
  if (swap) pendingSwaps.set(txid, swap)
  return swap
}


/** Bounded re-registration for a swap Pioneer reports as not_found. Pioneer
 *  signals "no row" two different ways depending on deployment: a 200 body with
 *  status='not_found' (handled in the GetPendingSwap success path) OR an HTTP
 *  404 that swagger-client throws (the live pioneer-server — see
 *  pending-swaps.controller.ts). BOTH must re-register, so this helper is called
 *  from both sites. NEAR Intents is excluded (stays not_found by design; 1Click
 *  is authoritative) and terminal swaps are skipped. The next refresh confirms
 *  the row landed and clears the bookkeeping in the success path. */
async function reregisterIfMissing(swap: PendingSwap): Promise<void> {
  const txid = swap.txid
  const isNear = isNearIntentsSwap(swap) || swap.integration === 'nearIntents'
  if (isNear || isTerminalSwapStatus(swap.status)) return
  const attempts = pioneerRegistrationAttempts.get(txid) || 0
  if (attempts < MAX_PIONEER_REGISTER_ATTEMPTS) {
    pioneerRegistrationAttempts.set(txid, attempts + 1)
    console.log(`${TAG} Pioneer has no row for ${txid.slice(0, 10)}... — re-registering (attempt ${attempts + 1}/${MAX_PIONEER_REGISTER_ATTEMPTS})`)
    try {
      await registerWithPioneer(swap)
      console.log(`${TAG} Pioneer re-registration submitted for ${txid.slice(0, 10)}... — verifying on next refresh`)
    } catch (e: any) {
      console.warn(`${TAG} Pioneer re-registration attempt ${attempts + 1} failed for ${txid.slice(0, 10)}...: ${e.message}`)
    }
  } else if (attempts === MAX_PIONEER_REGISTER_ATTEMPTS) {
    console.warn(`${TAG} Giving up Pioneer registration for ${txid.slice(0, 10)}... after ${attempts} attempts`)
    pioneerRegistrationAttempts.set(txid, attempts + 1) // bump past so this fires once
  }
}

/** Single on-demand Pioneer poll for one swap.
 *  Called by the SwapDialog while the user has it open (there is no background
 *  timer). Returns the latest in-memory swap state, or null if unknown. */
export async function refreshSwap(txid: string, deviceId?: string, walletId?: string, rescan = false): Promise<PendingSwap | null> {
  const live = pendingSwaps.get(txid)
  let swap = live && (walletId ? live.walletId === walletId : !deviceId || live.deviceId === deviceId) ? live : hydrateFromDb(txid, deviceId, walletId)
  if (!swap) {
    swapLog(`${TAG} refreshSwap: txid ${txid.slice(0, 10)}... not found in memory or DB`)
    return null
  }

  // Relay request-id backfill is two phases, both retry-safe:
  //   1. Local backfill: api.relay.link/requests/v2?hash= once we don't have
  //      the id locally. Cheap; only fires until swap.relayRequestId is set.
  //   2. Pioneer registration: re-post CreatePendingSwap so its checkRelaySwap
  //      monitor can key on relayData.requestId. Retries on every refreshSwap
  //      until the next GetPendingSwap response confirms Pioneer reflects our
  //      id (relayPioneerVerified set after applyRemoteSwapData below). This
  //      handles the case where Pioneer's CreatePendingSwap is a no-op upsert
  //      or 409s on the duplicate hash — without verification we'd silently
  //      give up after one attempt and the original "stuck on confirmation
  //      watcher" bug would reappear for a subset of swaps.
  if (shouldBackfillRelayRequestId(swap)) {
    if (!swap.relayRequestId) {
      const id = await fetchRelayRequestIdByHash(swap.txid)
      if (id) {
        swap.relayRequestId = id
        try { setSwapRelayRequestId(swap.txid, id, swap.deviceId, swap.walletId) } catch { /* best-effort */ }
        pushUpdate(swap)
        swapLog(`${TAG} Relay requestId backfilled for ${swap.txid.slice(0, 10)}...: ${id.slice(0, 12)}...`)
      }
    }
    if (swap.relayRequestId && !relayPioneerVerified.has(swap.txid)) {
      const attempts = relayRegisterAttempts.get(swap.txid) || 0
      if (attempts >= MAX_RELAY_REGISTER_ATTEMPTS) {
        // Loud one-time log per refresh after we've given up. The local
        // tracker link still works; only Pioneer's checkRelaySwap monitor
        // is left without the id, which means stuck-status detection on
        // the Pioneer side won't resolve until pioneer-server ships an
        // explicit UpdatePendingSwap / PATCH endpoint.
        if (attempts === MAX_RELAY_REGISTER_ATTEMPTS) {
          console.warn(`${TAG} Giving up Pioneer re-registration with Relay id for ${swap.txid.slice(0, 10)}... after ${attempts} attempts — needs a Pioneer-side update endpoint, see PR #152 review thread`)
          relayRegisterAttempts.set(swap.txid, attempts + 1) // bump past so this log only fires once
        }
      } else {
        relayRegisterAttempts.set(swap.txid, attempts + 1)
        const ok = await setRelayRequestIdOnPioneer(swap)
        if (ok) swapLog(`${TAG} Pioneer (re-)registered with relayRequestId for ${swap.txid.slice(0, 10)}... attempt=${attempts + 1} — awaiting verification`)
      }
    }

    const relayStatus = await fetchRelayExecutionStatus(swap)
    const mappedRelayStatus = mapRelayExecutionStatus(relayStatus?.status)
    const relayChanged = applyRelayExecutionStatus(swap, relayStatus)
    const hasEnoughRelayTerminalData = hasEnoughRelayTerminalMetadata(swap)
    if (
      (relayChanged && isTerminalSwapStatus(swap.status) && hasEnoughRelayTerminalData) ||
      (mappedRelayStatus && isTerminalSwapStatus(mappedRelayStatus) && mappedRelayStatus === swap.status && hasEnoughRelayTerminalData)
    ) return swap
  }

  // NEAR Intents: poll 1Click directly for status + NEAR tx hash.
  // Pioneer registration often fails for NEAR Intents swaps (400 at broadcast
  // time), so GetPendingSwap returns not_found forever. 1Click is the
  // authoritative source — check it on every refresh until terminal.
  if ((isNearIntentsSwap(swap) || swap.integration === 'nearIntents') && !isTerminalSwapStatus(swap.status) && swap.inboundAddress) {
    try {
      const resp = await fetch(
        `https://1click.chaindefuser.com/v0/status?depositAddress=${encodeURIComponent(swap.inboundAddress)}`,
        { signal: AbortSignal.timeout(8000) },
      )
      if (resp.ok) {
        const data = await resp.json() as any
        const oneClickStatus: string = data?.status || ''
        const nearHash: string | undefined = data?.swapDetails?.nearTxHashes?.[0] ?? data?.nearTxHashes?.[0]
        const outboundHash: string | undefined = data?.swapDetails?.destinationChainTxHashes?.[0]?.hash
        swapLog(`${TAG} NEAR Intents: 1Click status=${oneClickStatus} for ${txid.slice(0, 10)}...`)

        if (oneClickStatus === 'SUCCESS') {
          swap.status = 'completed'
          swap.outboundTxid = outboundHash || swap.outboundTxid
          swap.outboundChainId = swap.toChainId
          if (nearHash) swap.nearTxHash = nearHash
          swap.updatedAt = Date.now()
          if (!noPersistSwaps.has(swap.txid)) {
            updateSwapHistoryStatus(swap.txid, 'completed', {
              outboundTxid: outboundHash,
              outboundChainId: swap.toChainId,
              nearTxHash: nearHash,
              completedAt: Date.now(),
            })
          }
          pushUpdate(swap)
          if (swap.deviceId) {
            try {
              recordSwap({
                deviceId: swap.deviceId,
                txid: swap.txid,
                fromAsset: swap.fromSymbol,
                fromChainId: swap.fromChainId,
                fromAmount: parseFloat(swap.fromAmount) || 0,
                toAsset: swap.toSymbol,
                toChainId: swap.toChainId,
                toAmount: parseFloat(swap.receivedOutput || swap.expectedOutput) || 0,
              })
            } catch { /* non-fatal */ }
          }
          pushComplete(swap)
          swapLog(`${TAG} NEAR Intents: completed via 1Click for ${txid.slice(0, 10)}... outbound=${outboundHash?.slice(0, 12)}...`)
          return swap
        } else if (oneClickStatus === 'REFUNDED') {
          const refundReason = data?.swapDetails?.refundReason || 'REFUNDED'
          swap.status = 'refunded'
          swap.refundReason = refundReason
          if (nearHash) swap.nearTxHash = nearHash
          swap.updatedAt = Date.now()
          if (!noPersistSwaps.has(swap.txid)) {
            updateSwapHistoryStatus(swap.txid, 'refunded', {
              nearTxHash: nearHash,
              refundReason,
              completedAt: Date.now(),
            })
          }
          pushUpdate(swap)
          pushComplete(swap)
          swapLog(`${TAG} NEAR Intents: refunded via 1Click for ${txid.slice(0, 10)}... reason=${refundReason}`)
          return swap
        } else if (nearHash && !swap.nearTxHash) {
          swap.nearTxHash = nearHash
          pushUpdate(swap)
          if (!noPersistSwaps.has(swap.txid)) updateSwapHistoryStatus(swap.txid, swap.status, { nearTxHash: nearHash })
          swapLog(`${TAG} NEAR Intents: nearTxHash backfilled for ${txid.slice(0, 10)}... → ${nearHash.slice(0, 12)}...`)
        }
      }
    } catch { /* best-effort */ }
  }

  const pioneer = await getPioneer()
  try {
    // Manual recheck (rescan=true) forces Pioneer to re-derive from chain
    // (GET /swaps/pending/{txHash}?rescan=true) — lets the user recover a
    // mis-classified failed/stuck swap on demand. Auto-polling passes false
    // to keep Pioneer load down.
    const resp = await withTimeout(pioneer.GetPendingSwap({ txHash: txid, ...(rescan ? { rescan: true } : {}) }), PIONEER_SWAP_TIMEOUT_MS, rescan ? 'GetPendingSwap rescan' : 'GetPendingSwap')
    const remoteSwap = resp?.data || resp
    if (!remoteSwap || remoteSwap.status === 'not_found') {
      swapLog(`${TAG} refreshSwap ${txid.slice(0, 10)}...: not found in Pioneer yet`)
      // 200-body not_found (some client/server combos). The live pioneer-server
      // instead throws a 404, handled in the catch below — both call the same
      // bounded re-registration so a missed initial registration self-heals.
      await reregisterIfMissing(swap)
      return swap
    }
    swapLog(`${TAG} refreshSwap ${txid.slice(0, 10)}...: status=${remoteSwap.status}, confirmations=${remoteSwap.confirmations || 0}`)
    // Pioneer returned a real row — registration is confirmed (covers the case
    // where the initial call timed out *after* Pioneer created the row). Drop any
    // re-registration bookkeeping so we don't re-post CreatePendingSwap (409s,
    // noise) and don't leak the map entry for the process lifetime. Key on
    // swap.txid to match reregisterIfMissing (the txid param may differ in case).
    pioneerRegistrationAttempts.delete(swap.txid)
    applyRemoteSwapData(swap, remoteSwap)

    // Pioneer-side relay-id verification. If GetPendingSwap reports our id,
    // mark the txid as Pioneer-verified so the lazy re-registration loop
    // above stops on the next refresh. Without this verification the loop
    // either never stopped (chatty) or stopped after one attempt that may
    // have silently failed to land — the original P2 finding.
    if (swap.relayRequestId && !relayPioneerVerified.has(swap.txid)) {
      const remoteId = (remoteSwap?.relayData?.requestId || '').toLowerCase()
      if (remoteId && remoteId === swap.relayRequestId.toLowerCase()) {
        relayPioneerVerified.add(swap.txid)
        swapLog(`${TAG} Pioneer relay-id verified for ${swap.txid.slice(0, 10)}... — re-registration loop done`)
      }
    }

    // If just completed without an outbound txid, request a rescan to pick it up.
    if (swap.status === 'completed' && !swap.outboundTxid) {
      try {
        const rescanResp = await withTimeout(pioneer.GetPendingSwap({ txHash: txid, rescan: true }), PIONEER_SWAP_TIMEOUT_MS, 'GetPendingSwap rescan')
        const rescanData = rescanResp?.data || rescanResp
        if (rescanData && rescanData.status !== 'not_found') applyRemoteSwapData(swap, rescanData)
      } catch (e: any) {
        console.warn(`${TAG} refreshSwap rescan failed for ${txid.slice(0, 10)}...: ${e.message}`)
      }
    }

    // ── Midgard truth pass (Maya only — Thor has no public midgard) ──
    // Pioneer maps refunds → 'completed' and uses toAsset.chainId for the
    // explorer link. Both are wrong for the failure path. Hit Midgard
    // directly and let classifySwapOutcome correct the record.
    if (swap.integration === 'mayachain') {
      const midgard = await fetchMayaMidgardActions(txid)
      if (applyClassifiedOutcome(swap, midgard)) {
        const isFinal = swap.status === 'completed' || swap.status === 'failed' || swap.status === 'refunded'
        if (!noPersistSwaps.has(swap.txid)) updateSwapHistoryStatus(swap.txid, swap.status, {
          outboundTxid: swap.outboundTxid,
          outboundChainId: swap.outboundChainId,
          refundReason: swap.refundReason,
          error: swap.error,
          completedAt: isFinal ? Date.now() : undefined,
        })
        pushUpdate(swap)
      }
    }

    // Post-Pioneer relay backfill: if the swap just went terminal and the
    // initial backfill (above) found nothing (tx not indexed yet by relay.link),
    // try once more now that confirmation has propagated. This closes the race
    // where polling stops before the ID is available, leaving the tracker button
    // permanently absent from the submitted page.
    if (shouldBackfillRelayRequestId(swap) && !swap.relayRequestId && isTerminalSwapStatus(swap.status)) {
      const id = await fetchRelayRequestIdByHash(swap.txid)
      if (id) {
        swap.relayRequestId = id
        try { setSwapRelayRequestId(swap.txid, id, swap.deviceId, swap.walletId) } catch { /* best-effort */ }
        pushUpdate(swap)
        swapLog(`${TAG} Relay requestId backfilled (post-terminal) for ${swap.txid.slice(0, 10)}...: ${id.slice(0, 12)}...`)
      }
    }

    // Pioneer can remain stuck on Relay swaps even after Relay itself has
    // marked the request successful. Re-apply Relay's direct status last so a
    // stale Pioneer `pending` response cannot downgrade the local tracker.
    if (shouldBackfillRelayRequestId(swap)) {
      const relayStatus = await fetchRelayExecutionStatus(swap)
      applyRelayExecutionStatus(swap, relayStatus)
    }

  } catch (e: any) {
    if (e.status === 404 || e.statusCode === 404 || e.message?.includes('404')) {
      // The live pioneer-server returns HTTP 404 for not_found (swagger-client
      // throws on non-2xx, so we land here, not the 200-body branch above). This
      // is the same "no row in Pioneer" condition — re-register, bounded, so a
      // missed/transient-failed initial registration self-heals instead of the
      // tracker hanging on "waiting for confirmations" forever.
      swapLog(`${TAG} refreshSwap ${txid.slice(0, 10)}...: not found in Pioneer (404)`)
      await reregisterIfMissing(swap)
    } else {
      console.error(`${TAG} refreshSwap FAILED for ${txid.slice(0, 10)}...: ${e.message}`)
    }
  }
  return swap
}

// ── Midgard fallback: source-of-truth for Maya/Thor swap outcomes ──
//
// Pioneer's normalized status maps refunds -> 'completed', and we previously
// keyed the explorer URL on toAsset.chainId. Both are wrong for refunds, where
// the outbound is on the source chain. Midgard's action.type='refund' is
// unambiguous; it also tells us the actual outbound chain via the action.out
// asset. Maya has a working public Midgard at midgard.mayachain.info; Thor's
// Midgard has no live public mirror at the moment so this only covers Maya.
//
// We fetch on every refreshSwap for Maya integrations. Failure to reach
// Midgard is non-fatal: we fall back to Pioneer's view.
const MAYA_MIDGARD_BASE = 'https://midgard.mayachain.info'

async function fetchMayaMidgardActions(txid: string): Promise<MidgardActionsResponse | null> {
  const normalized = txid.replace(/^0x/i, '').toUpperCase()
  const url = `${MAYA_MIDGARD_BASE}/v2/actions?txid=${normalized}`
  try {
    const resp = await fetch(url, { headers: { accept: 'application/json' } })
    if (!resp.ok) {
      swapLog(`${TAG} Maya midgard fetch ${resp.status} for ${txid.slice(0, 10)}...`)
      return null
    }
    return await resp.json() as MidgardActionsResponse
  } catch (e: any) {
    console.warn(`${TAG} Maya midgard fetch failed for ${txid.slice(0, 10)}...: ${e?.message || e}`)
    return null
  }
}

function applyClassifiedOutcome(swap: PendingSwap, midgard: MidgardActionsResponse | null): boolean {
  if (!midgard) return false
  const outcome = classifySwapOutcome(midgard)
  if (outcome.status === 'unknown') return false

  let changed = false
  if (outcome.status !== swap.status) {
    swap.status = outcome.status
    changed = true
  }
  if (outcome.outboundTxid && outcome.outboundTxid !== swap.outboundTxid) {
    swap.outboundTxid = outcome.outboundTxid
    changed = true
  }
  if (outcome.outboundChainId && outcome.outboundChainId !== swap.outboundChainId) {
    swap.outboundChainId = outcome.outboundChainId
    changed = true
  }
  if (outcome.refundReason && outcome.refundReason !== swap.refundReason) {
    swap.refundReason = outcome.refundReason
    changed = true
  }
  if (!swap.midgardClassified) {
    swap.midgardClassified = true
    changed = true
  }
  if (changed) {
    swap.updatedAt = Date.now()
    swapLog(`${TAG} Midgard reclassified ${swap.txid.slice(0, 10)}... -> status=${outcome.status} outChain=${outcome.outboundChainId || 'n/a'}`)
  }
  return changed
}

/** Diagnostic snapshot for a single swap: local state + Pioneer state +
 *  Pioneer rescan result, with raw responses preserved. Surfaced via the
 *  `debugSwapLookup` RPC so the user can introspect why a swap is stuck
 *  without flipping the SWAP_DEBUG flag and re-broadcasting. Read-only —
 *  does not mutate the in-memory or persisted swap state.
 *
 *  PRIVACY: refuses to operate on passphrase-wallet swaps (txids tagged in
 *  noPersistSwaps). A passphrase swap stays in `pendingSwaps` for in-session
 *  UI but must never leak through any read RPC — including from a later
 *  standard-wallet session in the same vault process. Returns null with no
 *  Pioneer query so we don't even confirm the txid's existence. */
export async function debugSwapLookup(txid: string, deviceId?: string, walletId?: string): Promise<{
  txid: string
  pioneerBaseUrl: string | undefined
  local: PendingSwap | null
  pioneer: { ok: boolean; status: number | null; raw: any; error?: string }
  pioneerRescan: { ok: boolean; status: number | null; raw: any; error?: string }
  divergence?: { vaultProtocol: string; pioneerProtocol: string }
} | null> {
  if (noPersistSwaps.has(txid)) return null
  // readSwapFromDb (not hydrateFromDb) — debugSwapLookup is read-only and
  // must not promote an idle history row back into the active tracker registry.
  const live = pendingSwaps.get(txid)
  const local = live && (walletId ? live.walletId === walletId : !deviceId || live.deviceId === deviceId) ? live : readSwapFromDb(txid, deviceId, walletId)
  if ((walletId || deviceId) && !local) return null
  let pioneerBaseUrl: string | undefined
  try {
    const { getPioneerApiBase } = await import('./pioneer')
    pioneerBaseUrl = getPioneerApiBase()
  } catch { /* best-effort */ }

  const pioneer = await getPioneer()
  const tryCall = async (rescan: boolean) => {
    try {
      const resp = await withTimeout(
        pioneer.GetPendingSwap({ txHash: txid, ...(rescan ? { rescan: true } : {}) }),
        PIONEER_SWAP_TIMEOUT_MS,
        `GetPendingSwap${rescan ? ' rescan' : ''}`,
      )
      const raw = resp?.data || resp
      return { ok: true, status: 200, raw }
    } catch (e: any) {
      return { ok: false, status: e?.status ?? e?.statusCode ?? null, raw: null, error: e?.message || String(e) }
    }
  }
  const [p1, p2] = await Promise.all([tryCall(false), tryCall(true)])

  // Surface the protocol-tracking divergence loudly so the user sees the
  // exact failure mode: vault registered as X, Pioneer is monitoring as Y.
  const detectedProtocol = p1.raw?.details?.protocol?.protocol || p1.raw?.integration
  const localProto = (local?.swapper || local?.integration || '').toLowerCase()
  const remoteProto = (detectedProtocol || '').toLowerCase()
  const divergence = (localProto && remoteProto && !localProto.includes(remoteProto) && !remoteProto.includes(localProto))
    ? { vaultProtocol: localProto, pioneerProtocol: remoteProto }
    : undefined

  return { txid, pioneerBaseUrl, local, pioneer: p1, pioneerRescan: p2, divergence }
}

// ── Relay request-id backfill ───────────────────────────────────────
//
// Relay's request id (bytes32) keys their public status page and our tracker
// link. trackSwap extracts it from the prebuilt calldata for new swaps; this
// fallback covers legacy rows persisted before that extractor existed and any
// future Relay deposit selector we haven't taught the extractor about yet.
//
// We only attempt it for integrations that route through Relay (relay native,
// or shapeshift's Relay sub-route) and only when the id isn't already on the
// swap. The /requests/v2?hash=... endpoint matches against the inbound tx
// hash directly — no sender lookup or quote-shape parsing needed.

/** NEAR Intents maps to integration='shapeshift' in PIONEER_INTEGRATION_ALIAS
 *  but is NOT routed through Relay. Identify it by swapper so we can skip
 *  Relay-specific code paths that don't apply. */
function isNearIntentsSwap(swap: PendingSwap): boolean {
  const swapper = (swap.swapper || '').toLowerCase().replace(/\s/g, '')
  return swapper === 'nearintents' || swapper.startsWith('near')
}

function shouldBackfillRelayRequestId(swap: PendingSwap): boolean {
  // NEAR Intents shares the 'shapeshift' integration alias but is NOT a Relay swap.
  if (isNearIntentsSwap(swap)) return false
  const integration = (swap.integration || '').toLowerCase()
  // shapeshift may or may not be routing through Relay — the API call is cheap
  // and returns nothing for non-Relay swaps, so we let the lookup decide.
  if (integration === 'relay' || integration === 'shapeshift' || integration === 'shapeshiftswap') return true
  const swapper = (swap.swapper || '').toLowerCase().replace(/[\s_.-]/g, '')
  return swapper === 'relay' || swapper === 'relaylink' || swapper === 'relayexchange'
}

async function fetchRelayRequestIdByHash(txid: string): Promise<string | undefined> {
  try {
    const resp = await fetch(
      `https://api.relay.link/requests/v2?hash=${encodeURIComponent(txid)}`,
      { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } },
    )
    if (!resp.ok) {
      swapLog(`${TAG} Relay backfill: HTTP ${resp.status} for ${txid.slice(0, 10)}...`)
      return undefined
    }
    const data = await resp.json() as { requests?: Array<{ id?: string; data?: { inTxs?: Array<{ hash?: string }> } }> }
    // Prefer the request whose inTx hash matches exactly — Relay can return
    // siblings for the same user when the hash query is partial.
    const target = txid.toLowerCase()
    const match = (data.requests || []).find(r =>
      (r.data?.inTxs || []).some(t => (t.hash || '').toLowerCase() === target)
    ) || data.requests?.[0]
    return match?.id?.toLowerCase() || undefined
  } catch (e: any) {
    swapLog(`${TAG} Relay backfill failed for ${txid.slice(0, 10)}...: ${e?.message || e}`)
    return undefined
  }
}

async function fetchRelayExecutionStatus(swap: PendingSwap): Promise<RelayExecutionStatus | null> {
  if (!swap.relayRequestId) return null
  try {
    const resp = await fetch(
      `https://api.relay.link/intents/status/v3?requestId=${encodeURIComponent(swap.relayRequestId)}`,
      { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } },
    )
    if (!resp.ok) {
      swapLog(`${TAG} Relay status: HTTP ${resp.status} for ${swap.txid.slice(0, 10)}...`)
      return null
    }
    return await resp.json() as RelayExecutionStatus
  } catch (e: any) {
    swapLog(`${TAG} Relay status failed for ${swap.txid.slice(0, 10)}...: ${e?.message || e}`)
    return null
  }
}

function applyRelayExecutionStatus(swap: PendingSwap, relayStatus: RelayExecutionStatus | null): boolean {
  if (!relayStatus) return false
  const nextStatus = mapRelayExecutionStatus(relayStatus.status)
  if (!nextStatus) return false

  const now = Date.now()
  const final = isTerminalSwapStatus(nextStatus)
  const outboundTxid = relayOutboundTxid(relayStatus, swap.txid)
  const relayDetails = relayStatus.details || undefined
  const statusChanged = nextStatus !== swap.status
  const nextConfirmations = nextStatus !== 'pending'
    ? Math.max(swap.confirmations || 0, 1)
    : swap.confirmations
  const nextOutboundTxid = swap.outboundTxid || outboundTxid
  const nextOutboundConfirmations = final && nextStatus === 'completed' && nextOutboundTxid
    ? Math.max(swap.outboundConfirmations || 0, 1)
    : swap.outboundConfirmations
  const nextOutboundRequiredConfirmations = final && nextStatus === 'completed' && nextOutboundTxid
    ? Math.max(swap.outboundRequiredConfirmations || 0, 1)
    : swap.outboundRequiredConfirmations
  const nextError = nextStatus === 'failed' && relayDetails ? relayDetails : swap.error
  const nextRefundReason = nextStatus === 'refunded' && relayDetails ? relayDetails : swap.refundReason
  const metadataChanged =
    nextConfirmations !== swap.confirmations ||
    (!!outboundTxid && outboundTxid !== swap.outboundTxid) ||
    nextOutboundConfirmations !== swap.outboundConfirmations ||
    nextOutboundRequiredConfirmations !== swap.outboundRequiredConfirmations ||
    nextError !== swap.error ||
    nextRefundReason !== swap.refundReason
  if (!shouldApplyRelayStatus(swap.status, nextStatus, metadataChanged)) return false

  const receivedOutput = nextStatus === 'completed' && swap.receivedOutput === undefined
    ? undefined
    : swap.receivedOutput
  const completedAt = final ? (statusChanged ? now : swap.completedAt || now) : undefined
  const actualTimeSeconds = completedAt ? Math.round((completedAt - swap.createdAt) / 1000) : undefined

  swap.status = nextStatus
  swap.updatedAt = now
  swap.confirmations = nextConfirmations
  if (outboundTxid && !swap.outboundTxid) swap.outboundTxid = outboundTxid
  if (nextOutboundConfirmations !== undefined) swap.outboundConfirmations = nextOutboundConfirmations
  if (nextOutboundRequiredConfirmations !== undefined) swap.outboundRequiredConfirmations = nextOutboundRequiredConfirmations
  if (nextStatus === 'failed' && relayDetails) swap.error = nextError
  if (nextStatus === 'refunded' && relayDetails) {
    swap.refundReason = nextRefundReason
    swap.error = relayDetails
  }
  if (completedAt) swap.completedAt = completedAt

  swapLog(`${TAG} Relay status override: ${swap.txid.slice(0, 10)}... -> ${nextStatus} (relay=${relayStatus.status || 'unknown'}, outTxid=${swap.outboundTxid || 'none'})`)

  if (!noPersistSwaps.has(swap.txid)) updateSwapHistoryStatus(swap.txid, nextStatus, {
    deviceId: swap.deviceId,
    walletId: swap.walletId,
    outboundTxid: swap.outboundTxid || undefined,
    error: swap.error,
    receivedOutput,
    completedAt,
    actualTimeSeconds,
    refundReason: swap.refundReason,
  })

  pushUpdate(swap)
  if (final && statusChanged) pushComplete(swap)
  return true
}

function hasEnoughRelayTerminalMetadata(swap: PendingSwap): boolean {
  return swap.status !== 'completed' || !!swap.outboundTxid
}

/** Push the resolved Relay request id into Pioneer's existing pending-swap row.
 *
 *  Pioneer ships PUT /swaps/pending/{txHash} (operationId UpdatePendingSwap)
 *  which accepts { relayData: { requestId } }. Caller convention follows
 *  pioneer-client@>=11.1.0: body is the first arg, path/query the second.
 *
 *  Falls back to CreatePendingSwap when the live client doesn't expose
 *  UpdatePendingSwap (pioneer-client < 11.1.0 silently dropped PUT bodies,
 *  so older deploys never made the method usable even though the server
 *  endpoint existed). On the fallback path Pioneer may 409 on the duplicate
 *  txHash; we detect that and burn the caller's remaining attempts so the
 *  bounded loop stops instead of spinning on a permanent rejection.
 *
 *  Returns true if the call completed without throwing (verification happens
 *  by re-reading GetPendingSwap.relayData.requestId in refreshSwap); false
 *  on a thrown error. The user-visible relay tracker link works in either
 *  case since relayRequestId is stored locally first. */
async function setRelayRequestIdOnPioneer(swap: PendingSwap): Promise<boolean> {
  if (!swap.relayRequestId) return false
  try {
    const pioneer = await getPioneer()
    // Prefer the explicit update endpoint when the loaded swagger exposes
    // it. Spec confirmed shipping at api.keepkey.info; method also surfaces
    // on PatchPendingSwap and SetPendingSwapRelayData if pioneer-server
    // adds aliases later. Forward-compat at zero cost.
    const updateMethod = ['UpdatePendingSwap', 'PatchPendingSwap', 'SetPendingSwapRelayData']
      .find(name => typeof (pioneer as any)?.[name] === 'function')
    if (updateMethod) {
      await (pioneer as any)[updateMethod](
        { relayData: { requestId: swap.relayRequestId } },
        { txHash: swap.txid },
      )
      swapLog(`${TAG} Pioneer ${updateMethod} succeeded for ${swap.txid.slice(0, 10)}...`)
      return true
    }
    // Fallback: re-post CreatePendingSwap with the full body. This works
    // only if pioneer-server happens to upsert on duplicate txHash; if it
    // 409s the catch below burns remaining retries.
    await registerWithPioneer(swap)
    return true
  } catch (e: any) {
    const msg = String(e?.message || e || '')
    const isDuplicate = e?.status === 409
      || e?.statusCode === 409
      || /already exists|duplicate|409/i.test(msg)
    const isNotFound = e?.status === 404
      || e?.statusCode === 404
      || /not.found|404/i.test(msg)
    if (isDuplicate) {
      console.warn(`${TAG} Pioneer rejected Relay-id (re-)registration for ${swap.txid.slice(0, 10)}... as duplicate (${msg.slice(0, 80)}). Pioneer needs an UpdatePendingSwap endpoint — opening a tracking issue on pioneer-server.`)
      // Burn the remaining attempts so the caller's bounded loop stops on
      // the next refresh — there's no recovery from a permanent 409 without
      // a Pioneer-side change.
      relayRegisterAttempts.set(swap.txid, MAX_RELAY_REGISTER_ATTEMPTS)
    } else if (isNotFound) {
      // Swap not registered in Pioneer yet — race condition between broadcast
      // and CreatePendingSwap completing. refreshSwap will retry automatically.
      swapLog(`${TAG} Pioneer Relay-id registration: swap not yet registered (404) for ${swap.txid.slice(0, 10)}... will retry`)
    } else {
      console.warn(`${TAG} Pioneer Relay-id registration call failed for ${swap.txid.slice(0, 10)}...: ${msg.slice(0, 200)}`)
    }
    return false
  }
}

function mapPioneerStatus(status: string): SwapTrackingStatus {
  const map: Record<string, SwapTrackingStatus> = {
    pending: 'pending',
    confirming: 'confirming',
    output_detected: 'output_detected',
    output_confirming: 'output_confirming',
    output_confirmed: 'output_confirmed',
    completed: 'completed',
    failed: 'failed',
    refunded: 'refunded',
  }
  return map[status] || 'pending'
}

// ── RPC message pushing ─────────────────────────────────────────────

function pushUpdate(swap: PendingSwap): void {
  if (!sendMessage) {
    console.warn(`${TAG} sendMessage not initialized — cannot push swap-update`)
    return
  }
  const update: SwapStatusUpdate = {
    txid: swap.txid,
    status: swap.status,
    confirmations: swap.confirmations,
    outboundConfirmations: swap.outboundConfirmations,
    outboundRequiredConfirmations: swap.outboundRequiredConfirmations,
    outboundTxid: swap.outboundTxid,
    error: swap.error,
    swapper: swap.swapper,
    relayRequestId: swap.relayRequestId,
    outboundChainId: swap.outboundChainId,
    refundReason: swap.refundReason,
    nearTxHash: swap.nearTxHash,
    inboundBlockNumber: swap.inboundBlockNumber,
    inboundBlockHash: swap.inboundBlockHash,
    inboundGasUsed: swap.inboundGasUsed,
    inboundEffectiveGasPrice: swap.inboundEffectiveGasPrice,
    inboundConfirmedAt: swap.inboundConfirmedAt,
    errorActionable: swap.errorActionable,
    errorElapsedMinutes: swap.errorElapsedMinutes,
  }
  swapLog(`${TAG} Pushing swap-update: ${swap.txid} status=${swap.status} confirmations=${swap.confirmations}`)
  sendMessage('swap-update', update)
}

function pushComplete(swap: PendingSwap): void {
  if (!sendMessage) return
  swapLog(`${TAG} Pushing swap-complete: ${swap.txid} status=${swap.status}`)
  sendMessage('swap-complete', swap)
}
