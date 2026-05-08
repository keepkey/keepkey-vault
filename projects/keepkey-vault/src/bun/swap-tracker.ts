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
import { insertSwapHistory, updateSwapHistoryStatus, getSwapHistory, getSwapHistoryByTxid } from './db'
import { getTxReceiptOnce, EVM_RPC_URLS } from './evm-rpc'
import { assetData as discoveryAssetData } from '@pioneer-platform/pioneer-discovery'
import { VAULT_CHAIN_TO_THOR } from '../shared/swap-discovery'

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
import { decideRevertOutcome } from '../shared/swap-revert'
export { decideRevertOutcome } from '../shared/swap-revert'

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
let sendMessage: ((msg: string, data: any) => void) | null = null
let pioneerVerified = false
let initPromise: Promise<void> | null = null

// Required Pioneer SDK methods — app MUST NOT start without these
const REQUIRED_METHODS = ['CreatePendingSwap', 'GetPendingSwap'] as const

// ── Public API ──────────────────────────────────────────────────────

/** Check if the tracker has been initialized with a message sender */
export function isTrackerInitialized(): boolean {
  return sendMessage !== null
}

/** Initialize the tracker — verifies Pioneer SDK has required methods. Idempotent: safe to call multiple times. */
export async function initSwapTracker(messageSender: (msg: string, data: any) => void): Promise<void> {
  // Always update the message sender (supports re-init after failure)
  sendMessage = messageSender

  // If already verified, just update the sender and return
  if (pioneerVerified) return

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

  // Rehydrate active swaps from SQLite (survives app restart)
  try {
    const activeStatuses: SwapTrackingStatus[] = ['pending', 'confirming', 'output_detected', 'output_confirming', 'output_confirmed']
    for (const status of activeStatuses) {
      const records = getSwapHistory({ status, limit: 50 })
      for (const r of records) {
        if (pendingSwaps.has(r.txid)) continue
        const swap: PendingSwap = {
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
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          completedAt: r.completedAt,
          estimatedTime: r.estimatedTimeSeconds,
          slippageBps: r.slippageBps,
        }
        pendingSwaps.set(r.txid, swap)
      }
    }
    if (pendingSwaps.size > 0) {
      swapLog(`${TAG} Rehydrated ${pendingSwaps.size} active swap(s) from SQLite`)
      // No polling at boot — refreshSwap() drives status updates only when the
      // user opens that specific swap in the dialog.
    }
  } catch (e: any) {
    console.warn(`${TAG} Failed to rehydrate swaps from SQLite: ${e.message}`)
  }
}

/** Register a newly broadcast swap for tracking.
 *  @param opts.skipPersist - When true, skip DB writes (PRIVACY: passphrase wallets). */
export function trackSwap(
  result: SwapResult,
  params: ExecuteSwapParams,
  quote: SwapQuote,
  opts?: { skipPersist?: boolean },
): void {
  const now = Date.now()
  // CAIP is the only identifier the caller provides. Display strings
  // (symbol, name, THORChain-style asset) are derived here so UI/history
  // can render without a Pioneer round-trip — never used for routing.
  const fromDisplay = resolveDisplayFromCaip(params.fromCaip)
  const toDisplay = resolveDisplayFromCaip(params.toCaip)

  const swap: PendingSwap = {
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
  }

  pendingSwaps.set(result.txid, swap)
  swapLog(`${TAG} Tracking swap: ${result.txid} (${swap.fromSymbol} → ${swap.toSymbol})`)

  // Persist to SQLite — full lifecycle record. Asset string + symbols are
  // derived display fields, populated from the CAIP. CAIP is canonical.
  const historyRecord: SwapHistoryRecord = {
    id: crypto.randomUUID(),
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
  }
  // PRIVACY: Skip DB write for passphrase wallets — swap still tracked in-memory for UI.
  if (opts?.skipPersist) {
    noPersistSwaps.add(result.txid)
  } else {
    insertSwapHistory(historyRecord)
  }

  // Push immediate update to frontend FIRST (user sees "pending" instantly)
  pushUpdate(swap)

  // Register with Pioneer API — log errors but don't block (server processes async)
  registerWithPioneer(swap).catch((e) => {
    console.error(`${TAG} Pioneer registration FAILED for ${result.txid}: ${e.message}`)
    console.error(`${TAG} Stack: ${e.stack}`)
  })

  // Polling is on-demand — the UI calls refreshSwap(txid) once the dialog
  // mounts in the 'submitted' phase.
}

/** Get all pending swaps (for getPendingSwaps RPC) */
export function getPendingSwaps(): PendingSwap[] {
  return Array.from(pendingSwaps.values())
    .sort((a, b) => b.createdAt - a.createdAt)
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

  const body = {
    txHash: swap.txid,
    addresses: [],
    sellAsset: {
      caip: sellCaip,
      symbol: swap.fromSymbol,
      amount: swap.fromAmount,
      amountBaseUnits: swap.fromAmount,
      address: swap.inboundAddress || '',
      networkId: swap.fromChainId,
    },
    buyAsset: {
      caip: buyCaip,
      symbol: swap.toSymbol,
      amount: swap.expectedOutput,
      amountBaseUnits: swap.expectedOutput,
      address: '',
      networkId: swap.toChainId,
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

  swapLog(`${TAG} CreatePendingSwap request:`, JSON.stringify({ txHash: body.txHash, sellCaip: body.sellAsset.caip, buyCaip: body.buyAsset.caip, integration: body.integration, swapper: body.swapper }))

  const resp = await pioneer.CreatePendingSwap(body)
  swapLog(`${TAG} CreatePendingSwap response:`, JSON.stringify(resp?.data || resp))
  swapLog(`${TAG} Registered swap with Pioneer: ${swap.txid}`)
}

// ── On-demand Pioneer fetch ────────────────────────────────────────

/** Apply remote swap data to local swap, push updates if changed */
function applyRemoteSwapData(swap: PendingSwap, remoteSwap: any): void {
  const newStatus = mapPioneerStatus(remoteSwap.status)
  const confirmations = remoteSwap.confirmations ?? swap.confirmations
  const outboundConfirmations = remoteSwap.outboundConfirmations
  const outboundRequiredConfirmations = remoteSwap.outboundRequiredConfirmations
  const outboundTxid = remoteSwap.thorchainData?.outboundTxHash
    || remoteSwap.mayachainData?.outboundTxHash
    || remoteSwap.relayData?.outTxHashes?.[0]
  // Pioneer surfaces the detected underlying protocol in `details.protocol.protocol`.
  // If the quote-time parse missed `swapper` (common for aggregator routes where
  // ShapeShift's response shape varies), this is the authoritative value.
  const detectedSwapper: string | undefined = remoteSwap.details?.protocol?.protocol || remoteSwap.swapper || undefined
  const errorMsg = remoteSwap.error?.userMessage || remoteSwap.error?.message
    || (remoteSwap.error ? String(remoteSwap.error) : undefined)
  const timeEstimate = remoteSwap.timeEstimate

  const changed =
    newStatus !== swap.status ||
    confirmations !== swap.confirmations ||
    (outboundConfirmations !== undefined && outboundConfirmations !== swap.outboundConfirmations) ||
    (outboundTxid && outboundTxid !== swap.outboundTxid) ||
    (detectedSwapper && detectedSwapper !== swap.swapper)

  if (changed) {
    swap.status = newStatus
    swap.updatedAt = Date.now()
    swap.confirmations = confirmations
    if (outboundConfirmations !== undefined) swap.outboundConfirmations = outboundConfirmations
    if (outboundRequiredConfirmations !== undefined) swap.outboundRequiredConfirmations = outboundRequiredConfirmations
    if (outboundTxid) swap.outboundTxid = outboundTxid
    if (errorMsg) swap.error = errorMsg
    if (detectedSwapper && !swap.swapper) swap.swapper = detectedSwapper

    if (timeEstimate?.total_swap_seconds && timeEstimate.total_swap_seconds > 0) {
      swap.estimatedTime = timeEstimate.total_swap_seconds
    }

    const receivedOutput = (remoteSwap.buyAsset?.amount && parseFloat(remoteSwap.buyAsset.amount) > 0)
      ? remoteSwap.buyAsset.amount
      : undefined
    if (receivedOutput) {
      swap.receivedOutput = receivedOutput
      // Backward-compat: display still reads expectedOutput in some places.
      swap.expectedOutput = receivedOutput
    }

    swapLog(`${TAG} Status change: ${swap.txid} → ${newStatus} (confirmations=${confirmations}, outbound=${outboundConfirmations || 0}/${outboundRequiredConfirmations || '?'}, outTxid=${outboundTxid || 'none'})`)

    // Persist status change to SQLite (skip for passphrase wallet swaps)
    const isFinal = newStatus === 'completed' || newStatus === 'failed' || newStatus === 'refunded'
    const now = Date.now()
    if (!noPersistSwaps.has(swap.txid)) updateSwapHistoryStatus(swap.txid, newStatus, {
      outboundTxid: outboundTxid || undefined,
      error: errorMsg || undefined,
      receivedOutput,
      swapper: swap.swapper,
      completedAt: isFinal ? now : undefined,
      actualTimeSeconds: isFinal ? Math.round((now - swap.createdAt) / 1000) : undefined,
    })

    pushUpdate(swap)

    if (isFinal) {
      pushComplete(swap)
    }
  }
}

/** Hydrate the in-memory swap from the persisted record. Returns null when
 *  the swap is unknown to both. */
function hydrateFromDb(txid: string): PendingSwap | null {
  const r = getSwapHistoryByTxid(txid)
  if (!r) return null
  const swap: PendingSwap = {
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
  }
  pendingSwaps.set(txid, swap)
  return swap
}

// Vault stores fromChainId in mixed formats — historical 'ethereum', current
// 'eip155:1', or sometimes the bare numeric. Map any of them to the EVM_RPC_URLS
// numeric key. Anything not in this table is treated as non-EVM.
const EVM_CHAIN_TO_NUMERIC: Record<string, string> = {
  ethereum: '1', polygon: '137', arbitrum: '42161', optimism: '10',
  avalanche: '43114', bsc: '56', base: '8453',
}
function evmRpcUrlFor(fromChainId: string): string | undefined {
  if (!fromChainId) return undefined
  // CAIP form: "eip155:1" → "1"
  if (fromChainId.startsWith('eip155:')) return EVM_RPC_URLS[fromChainId.slice('eip155:'.length)]
  // Legacy slug: "ethereum" → "1" → URL
  if (EVM_CHAIN_TO_NUMERIC[fromChainId]) return EVM_RPC_URLS[EVM_CHAIN_TO_NUMERIC[fromChainId]]
  // Bare numeric: "1" → URL
  return EVM_RPC_URLS[fromChainId]
}

/** Check the EVM source receipt directly. If status=0x0 the tx reverted on-chain
 *  (allowance failed, contract revert, etc.) — the swap will NEVER complete and
 *  the user is just being lied to with "waiting for confirmations". Mark failed
 *  + push update so the UI flips to a failure state.
 *
 *  Returns true if we definitively flagged the swap as failed (caller should
 *  short-circuit any further status polling). */
async function detectEvmRevert(swap: PendingSwap): Promise<boolean> {
  const rpcUrl = evmRpcUrlFor(swap.fromChainId || '')
  if (!rpcUrl) return false
  try {
    const receipt = await getTxReceiptOnce(rpcUrl, swap.txid)
    const decision = decideRevertOutcome(swap.status, receipt)
    if (!decision) return false
    console.warn(`${TAG} EVM source tx REVERTED on-chain: ${swap.txid} (block ${decision.blockNumber}) — marking failed`)
    swap.status = decision.status
    swap.error = decision.error
    swap.updatedAt = Date.now()
    try { updateSwapHistoryStatus(swap.txid, 'failed') } catch { /* ignore */ }
    pushUpdate(swap)
    return true
  } catch (e: any) {
    console.warn(`${TAG} EVM receipt check failed for ${swap.txid.slice(0, 10)}...: ${e.message}`)
  }
  return false
}

/** Single on-demand Pioneer poll for one swap.
 *  Called by the SwapDialog while the user has it open (there is no background
 *  timer). Returns the latest in-memory swap state, or null if unknown. */
export async function refreshSwap(txid: string): Promise<PendingSwap | null> {
  let swap = pendingSwaps.get(txid) || hydrateFromDb(txid)
  if (!swap) {
    swapLog(`${TAG} refreshSwap: txid ${txid.slice(0, 10)}... not found in memory or DB`)
    return null
  }

  // Detect EVM revert FIRST — Pioneer's THORChain/Maya queries return "still
  // processing" forever for reverted txs because the protocol never observed
  // them. Without this check the user sees "waiting for confirmations" until
  // the heat-death of the universe.
  if (await detectEvmRevert(swap)) return swap

  const pioneer = await getPioneer()
  try {
    const resp = await pioneer.GetPendingSwap({ txHash: txid })
    const remoteSwap = resp?.data || resp
    if (!remoteSwap || remoteSwap.status === 'not_found') {
      swapLog(`${TAG} refreshSwap ${txid.slice(0, 10)}...: not found in Pioneer yet`)
      return swap
    }
    swapLog(`${TAG} refreshSwap ${txid.slice(0, 10)}...: status=${remoteSwap.status}, confirmations=${remoteSwap.confirmations || 0}`)
    applyRemoteSwapData(swap, remoteSwap)

    // If just completed without an outbound txid, request a rescan to pick it up.
    if (swap.status === 'completed' && !swap.outboundTxid) {
      try {
        const rescanResp = await pioneer.GetPendingSwap({ txHash: txid, rescan: true })
        const rescanData = rescanResp?.data || rescanResp
        if (rescanData && rescanData.status !== 'not_found') applyRemoteSwapData(swap, rescanData)
      } catch (e: any) {
        console.warn(`${TAG} refreshSwap rescan failed for ${txid.slice(0, 10)}...: ${e.message}`)
      }
    }
  } catch (e: any) {
    if (e.status === 404 || e.statusCode === 404 || e.message?.includes('404')) {
      swapLog(`${TAG} refreshSwap ${txid.slice(0, 10)}...: not indexed yet (404)`)
    } else {
      console.error(`${TAG} refreshSwap FAILED for ${txid.slice(0, 10)}...: ${e.message}`)
    }
  }
  return swap
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
  }
  swapLog(`${TAG} Pushing swap-update: ${swap.txid} status=${swap.status} confirmations=${swap.confirmations}`)
  sendMessage('swap-update', update)
}

function pushComplete(swap: PendingSwap): void {
  if (!sendMessage) return
  swapLog(`${TAG} Pushing swap-complete: ${swap.txid} status=${swap.status}`)
  sendMessage('swap-complete', swap)
}
