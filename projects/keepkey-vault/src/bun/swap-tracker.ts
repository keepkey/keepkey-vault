/**
 * Swap Tracker — monitors pending swaps via Pioneer HTTP polling.
 *
 * After executeSwap broadcasts a tx, the tracker:
 *   1. Registers the swap with Pioneer (CreatePendingSwap)
 *   2. Polls Pioneer API (GetPendingSwap per txHash) for status updates
 *   3. Pushes status changes to the frontend via RPC messages
 *   4. Auto-removes completed/failed swaps after a grace period
 *
 * Pioneer operationIds used:
 *   - CreatePendingSwap  (POST /swaps/pending)
 *   - GetPendingSwap     (GET  /swaps/pending/{txHash})
 */
import type { PendingSwap, SwapTrackingStatus, SwapStatusUpdate, SwapResult, ExecuteSwapParams, SwapQuote, SwapHistoryRecord } from '../shared/types'
import { getPioneer } from './pioneer'
import { assetToCaip } from './swap-parsing'
import { insertSwapHistory, updateSwapHistoryStatus, getSwapHistory } from './db'

const TAG = '[swap-tracker]'

// ── In-memory swap registry ─────────────────────────────────────────

const pendingSwaps = new Map<string, PendingSwap>()
let pollTimer: ReturnType<typeof setTimeout> | null = null
let sendMessage: ((msg: string, data: any) => void) | null = null
let pioneerVerified = false

/** Adaptive polling: fast at first, backs off as swap ages */
const FAST_POLL_MS = 10_000       // 10s for first 2 minutes
const NORMAL_POLL_MS = 20_000     // 20s for 2-10 minutes
const SLOW_POLL_MS = 30_000       // 30s after 10 minutes
const FAST_PHASE_MS = 2 * 60_000  // 2 min
const NORMAL_PHASE_MS = 10 * 60_000 // 10 min
const COMPLETED_GRACE_MS = 120_000 // keep completed swaps visible for 2 min

// Required Pioneer SDK methods — app MUST NOT start without these
const REQUIRED_METHODS = ['CreatePendingSwap', 'GetPendingSwap'] as const

// ── Public API ──────────────────────────────────────────────────────

/** Initialize the tracker — verifies Pioneer SDK has required methods. Throws on failure. */
export async function initSwapTracker(messageSender: (msg: string, data: any) => void): Promise<void> {
  sendMessage = messageSender

  // FAIL FAST: Verify Pioneer SDK exposes the swap tracking methods
  const pioneer = await getPioneer()
  const missing: string[] = []
  for (const method of REQUIRED_METHODS) {
    if (typeof pioneer[method] !== 'function') {
      missing.push(method)
    }
  }
  if (missing.length > 0) {
    // Log all available methods for debugging
    const available = Object.keys(pioneer).filter(k => typeof pioneer[k] === 'function')
    console.error(`${TAG} FATAL: Pioneer SDK missing required methods: ${missing.join(', ')}`)
    console.error(`${TAG} Available methods: ${available.join(', ')}`)
    throw new Error(`Pioneer SDK missing swap tracking methods: ${missing.join(', ')}. Cannot track swaps.`)
  }

  pioneerVerified = true
  console.log(`${TAG} Tracker initialized — Pioneer SDK verified (${REQUIRED_METHODS.join(', ')})`)

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
          fromAmount: r.fromAmount,
          expectedOutput: r.quotedOutput,
          memo: r.memo,
          inboundAddress: r.inboundAddress,
          router: r.router,
          integration: r.integration,
          status: r.status,
          confirmations: 0,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          estimatedTime: r.estimatedTimeSeconds,
        }
        pendingSwaps.set(r.txid, swap)
      }
    }
    if (pendingSwaps.size > 0) {
      console.log(`${TAG} Rehydrated ${pendingSwaps.size} active swap(s) from SQLite`)
      startPolling()
    }
  } catch (e: any) {
    console.warn(`${TAG} Failed to rehydrate swaps from SQLite: ${e.message}`)
  }
}

/** Register a newly broadcast swap for tracking */
export function trackSwap(
  result: SwapResult,
  params: ExecuteSwapParams,
  quote: SwapQuote,
): void {
  const now = Date.now()
  const swap: PendingSwap = {
    txid: result.txid,
    fromAsset: params.fromAsset,
    toAsset: params.toAsset,
    fromSymbol: params.fromAsset.split('.').pop()?.split('-')[0] || params.fromAsset,
    toSymbol: params.toAsset.split('.').pop()?.split('-')[0] || params.toAsset,
    fromChainId: params.fromChainId,
    toChainId: params.toChainId,
    fromAmount: params.amount,
    expectedOutput: params.expectedOutput,
    memo: params.memo,
    inboundAddress: params.inboundAddress,
    router: params.router,
    integration: quote.integration || 'thorchain',
    status: 'pending',
    confirmations: 0,
    createdAt: now,
    updatedAt: now,
    estimatedTime: quote.estimatedTime,
  }

  pendingSwaps.set(result.txid, swap)
  console.log(`${TAG} Tracking swap: ${result.txid} (${swap.fromSymbol} → ${swap.toSymbol})`)

  // Persist to SQLite — full lifecycle record
  const historyRecord: SwapHistoryRecord = {
    id: crypto.randomUUID(),
    txid: result.txid,
    fromAsset: params.fromAsset,
    toAsset: params.toAsset,
    fromSymbol: swap.fromSymbol,
    toSymbol: swap.toSymbol,
    fromChainId: params.fromChainId,
    toChainId: params.toChainId,
    fromAmount: params.amount,
    quotedOutput: quote.expectedOutput || params.expectedOutput,
    minimumOutput: quote.minimumOutput || '0',
    slippageBps: quote.slippageBps || 300,
    feeBps: quote.fees?.totalBps || 0,
    feeOutbound: quote.fees?.outbound || '0',
    integration: quote.integration || 'thorchain',
    memo: params.memo,
    inboundAddress: params.inboundAddress,
    router: params.router,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    estimatedTimeSeconds: quote.estimatedTime || 0,
    approvalTxid: result.approvalTxid,
  }
  insertSwapHistory(historyRecord)

  // Push immediate update to frontend FIRST (user sees "pending" instantly)
  pushUpdate(swap)

  // Register with Pioneer API — log errors but don't block (server processes async)
  registerWithPioneer(swap).catch((e) => {
    console.error(`${TAG} Pioneer registration FAILED for ${result.txid}: ${e.message}`)
    console.error(`${TAG} Stack: ${e.stack}`)
  })

  // Start polling
  startPolling()
}

/** Get all pending swaps (for getPendingSwaps RPC) */
export function getPendingSwaps(): PendingSwap[] {
  return Array.from(pendingSwaps.values())
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** Dismiss a swap from the tracker (user clicked dismiss) */
export function dismissSwap(txid: string): void {
  pendingSwaps.delete(txid)
  // Only stop polling when no ACTIVE swaps remain — don't kill polling for other pending swaps
  const hasActive = Array.from(pendingSwaps.values()).some(s =>
    s.status !== 'completed' && s.status !== 'failed' && s.status !== 'refunded'
  )
  if (pendingSwaps.size === 0 || !hasActive) {
    stopPolling()
  }
}

/** Convert THORChain asset to CAIP, falling back to the raw string on unsupported chains */
function safeAssetToCaip(thorAsset: string): string {
  try { return assetToCaip(thorAsset) } catch { return thorAsset }
}

// ── Pioneer REST registration ───────────────────────────────────────

async function registerWithPioneer(swap: PendingSwap): Promise<void> {
  const pioneer = await getPioneer()

  const body = {
    txHash: swap.txid,
    addresses: [],
    sellAsset: {
      caip: safeAssetToCaip(swap.fromAsset),
      symbol: swap.fromSymbol,
      amount: swap.fromAmount,
      amountBaseUnits: swap.fromAmount,
      address: swap.inboundAddress || '',
      networkId: swap.fromChainId,
    },
    buyAsset: {
      caip: safeAssetToCaip(swap.toAsset),
      symbol: swap.toSymbol,
      amount: swap.expectedOutput,
      amountBaseUnits: swap.expectedOutput,
      address: '',
      networkId: swap.toChainId,
    },
    quote: {
      id: swap.txid,
      integration: swap.integration,
      expectedAmountOut: swap.expectedOutput,
      minimumAmountOut: swap.expectedOutput,
      slippage: 3,
      fees: { affiliate: '0', protocol: '0', network: '0' },
      memo: swap.memo,
    },
    integration: swap.integration,
  }

  console.log(`${TAG} CreatePendingSwap request:`, JSON.stringify({ txHash: body.txHash, sellCaip: body.sellAsset.caip, buyCaip: body.buyAsset.caip, integration: body.integration }))

  const resp = await pioneer.CreatePendingSwap(body)
  console.log(`${TAG} CreatePendingSwap response:`, JSON.stringify(resp?.data || resp))
  console.log(`${TAG} Registered swap with Pioneer: ${swap.txid}`)
}

// ── HTTP Polling ────────────────────────────────────────────────────

/** Get adaptive poll interval based on oldest active swap age */
function getPollInterval(): number {
  let oldestAge = 0
  for (const swap of pendingSwaps.values()) {
    if (swap.status === 'completed' || swap.status === 'failed' || swap.status === 'refunded') continue
    const age = Date.now() - swap.createdAt
    if (age > oldestAge) oldestAge = age
  }
  if (oldestAge < FAST_PHASE_MS) return FAST_POLL_MS
  if (oldestAge < NORMAL_PHASE_MS) return NORMAL_POLL_MS
  return SLOW_POLL_MS
}

function startPolling(): void {
  if (pollTimer) return
  // Poll immediately on start, then schedule next
  pollAllSwaps().then(scheduleNextPoll)
}

/** Schedule next poll using setTimeout (prevents stacking if pollAllSwaps is slow) */
function scheduleNextPoll(): void {
  if (pollTimer) clearTimeout(pollTimer)
  // Don't schedule if no active swaps remain
  const hasActive = Array.from(pendingSwaps.values()).some(s =>
    s.status !== 'completed' && s.status !== 'failed' && s.status !== 'refunded'
  )
  if (pendingSwaps.size === 0 || !hasActive) {
    pollTimer = null
    return
  }
  const interval = getPollInterval()
  pollTimer = setTimeout(async () => {
    await pollAllSwaps()
    scheduleNextPoll()
  }, interval)
}

function stopPolling(): void {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
    console.log(`${TAG} Stopped polling (no active swaps)`)
  }
}

/** Apply remote swap data to local swap, push updates if changed */
function applyRemoteSwapData(swap: PendingSwap, remoteSwap: any): void {
  const newStatus = mapPioneerStatus(remoteSwap.status)
  const confirmations = remoteSwap.confirmations ?? swap.confirmations
  const outboundConfirmations = remoteSwap.outboundConfirmations
  const outboundRequiredConfirmations = remoteSwap.outboundRequiredConfirmations
  const outboundTxid = remoteSwap.thorchainData?.outboundTxHash
    || remoteSwap.mayachainData?.outboundTxHash
    || remoteSwap.relayData?.outTxHashes?.[0]
  const errorMsg = remoteSwap.error?.userMessage || remoteSwap.error?.message
    || (remoteSwap.error ? String(remoteSwap.error) : undefined)
  const timeEstimate = remoteSwap.timeEstimate

  const changed =
    newStatus !== swap.status ||
    confirmations !== swap.confirmations ||
    (outboundConfirmations !== undefined && outboundConfirmations !== swap.outboundConfirmations) ||
    (outboundTxid && outboundTxid !== swap.outboundTxid)

  if (changed) {
    swap.status = newStatus
    swap.updatedAt = Date.now()
    swap.confirmations = confirmations
    if (outboundConfirmations !== undefined) swap.outboundConfirmations = outboundConfirmations
    if (outboundRequiredConfirmations !== undefined) swap.outboundRequiredConfirmations = outboundRequiredConfirmations
    if (outboundTxid) swap.outboundTxid = outboundTxid
    if (errorMsg) swap.error = errorMsg

    if (timeEstimate?.total_swap_seconds && timeEstimate.total_swap_seconds > 0) {
      swap.estimatedTime = timeEstimate.total_swap_seconds
    }

    const receivedOutput = (remoteSwap.buyAsset?.amount && parseFloat(remoteSwap.buyAsset.amount) > 0)
      ? remoteSwap.buyAsset.amount
      : undefined
    if (receivedOutput) {
      swap.expectedOutput = receivedOutput
    }

    console.log(`${TAG} Status change: ${swap.txid} → ${newStatus} (confirmations=${confirmations}, outbound=${outboundConfirmations || 0}/${outboundRequiredConfirmations || '?'}, outTxid=${outboundTxid || 'none'})`)

    // Persist status change to SQLite
    const isFinal = newStatus === 'completed' || newStatus === 'failed' || newStatus === 'refunded'
    const now = Date.now()
    updateSwapHistoryStatus(swap.txid, newStatus, {
      outboundTxid: outboundTxid || undefined,
      error: errorMsg || undefined,
      receivedOutput,
      completedAt: isFinal ? now : undefined,
      actualTimeSeconds: isFinal ? Math.round((now - swap.createdAt) / 1000) : undefined,
    })

    pushUpdate(swap)

    if (isFinal) {
      pushComplete(swap)
    }
  }
}

async function pollAllSwaps(): Promise<void> {
  const active = Array.from(pendingSwaps.values()).filter(s =>
    s.status !== 'completed' && s.status !== 'failed' && s.status !== 'refunded'
  )

  if (active.length === 0) {
    // Clean up completed swaps past grace period
    const now = Date.now()
    for (const [txid, swap] of pendingSwaps) {
      if ((swap.status === 'completed' || swap.status === 'failed' || swap.status === 'refunded') &&
          now - swap.updatedAt > COMPLETED_GRACE_MS) {
        pendingSwaps.delete(txid)
      }
    }
    if (pendingSwaps.size === 0) {
      stopPolling()
    }
    return
  }

  const pioneer = await getPioneer()

  console.log(`${TAG} Polling ${active.length} active swap(s) via GetPendingSwap (per-txHash)...`)

  // Poll each swap individually — GetPendingSwap uses /swaps/pending/{txHash}
  // which doesn't conflict with the SwapHistoryController route
  for (const swap of active) {
    try {
      // GetPendingSwap expects txHash as a path parameter
      // pioneer-client for GET: first arg = parameters (mapped to spec params)
      const resp = await pioneer.GetPendingSwap({ txHash: swap.txid })
      const remoteSwap = resp?.data || resp

      if (!remoteSwap || remoteSwap.status === 'not_found') {
        console.log(`${TAG} Swap ${swap.txid.slice(0, 10)}... not found in Pioneer yet`)
        continue
      }

      console.log(`${TAG} GetPendingSwap ${swap.txid.slice(0, 10)}...: status=${remoteSwap.status}, confirmations=${remoteSwap.confirmations || 0}`)

      applyRemoteSwapData(swap, remoteSwap)

      // When swap just completed and we don't have outbound txid, do a rescan to get it
      if (swap.status === 'completed' && !swap.outboundTxid) {
        try {
          console.log(`${TAG} Swap completed but no outbound txid — requesting rescan...`)
          const rescanResp = await pioneer.GetPendingSwap({ txHash: swap.txid, rescan: true })
          const rescanData = rescanResp?.data || rescanResp
          if (rescanData && rescanData.status !== 'not_found') {
            applyRemoteSwapData(swap, rescanData)
          }
        } catch (e: any) {
          console.warn(`${TAG} Rescan failed for ${swap.txid.slice(0, 10)}...: ${e.message}`)
        }
      }
    } catch (e: any) {
      // 404 is expected for newly created swaps that haven't been indexed yet
      if (e.status === 404 || e.statusCode === 404 || e.message?.includes('404')) {
        console.log(`${TAG} Swap ${swap.txid.slice(0, 10)}... not indexed yet (404)`)
      } else {
        console.error(`${TAG} GetPendingSwap FAILED for ${swap.txid.slice(0, 10)}...: ${e.message}`)
      }
    }
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
  }
  console.log(`${TAG} Pushing swap-update: ${swap.txid} status=${swap.status} confirmations=${swap.confirmations}`)
  sendMessage('swap-update', update)
}

function pushComplete(swap: PendingSwap): void {
  if (!sendMessage) return
  console.log(`${TAG} Pushing swap-complete: ${swap.txid} status=${swap.status}`)
  sendMessage('swap-complete', swap)
}
