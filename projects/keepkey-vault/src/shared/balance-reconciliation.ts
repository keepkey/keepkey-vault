import type { ChainBalance, PendingSwap } from './types'

const TOKEN_NAMESPACE_RE = /\/(?:erc20|bep20|spl|token|trc20|cw20|denom|bank):/i

export interface SwapExecutionBalanceDetail {
  txid: string
  fromChainId: string
  toChainId: string
  fromCaip?: string
  toCaip?: string
  fromSymbol: string
  toSymbol: string
  expectedOutput?: string
  /** False when the user deliberately sent the output to an external address. */
  isWalletDestination?: boolean
}

/**
 * A swap can be terminal at the protocol before the portfolio indexer observes
 * its output. Keep this record until the destination amount is independently
 * visible in a confirmed balance response.
 */
export interface BalanceReconciliation {
  txid: string
  chainId: string
  assetCaip?: string
  symbol: string
  baselineAmount: number
  expectedOutput?: number
  terminal: boolean
  observed: boolean
  startedAt: number
  completedAt?: number
  attempts: number
  lastObservedAmount?: number
  /** Ceiling reached: terminal but never independently confirmed within the
   *  reconciliation window. Stops protecting the snapshot so the real balance
   *  shows through, and flips the banner to a dismissible "couldn't confirm"
   *  state instead of spinning forever (e.g. a flaky single-node ZEC indexer). */
  expired?: boolean
}

// How long a terminal-but-unobserved swap keeps protecting the snapshot before
// we give up and surface the real balance. Some destination chains ride a single
// flaky indexer (ZEC = one NowNodes node, no failover) that can lag or 403
// indefinitely — without a ceiling the "syncing" banner sticks forever.
export const RECONCILIATION_CEILING_MS = 15 * 60_000

function finiteAmount(value: unknown): number {
  const amount = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '0'))
  return Number.isFinite(amount) && amount >= 0 ? amount : 0
}

export function normalizeAssetCaip(caip: string | undefined): string {
  if (!caip) return ''
  // EVM contracts and network ids are case-insensitive. Base58 token ids are
  // case-sensitive, so preserve all non-EVM CAIPs byte-for-byte.
  return caip.startsWith('eip155:') ? caip.toLowerCase() : caip
}

export function balanceAmountForAsset(balance: ChainBalance | undefined, caip?: string): number {
  if (!balance) return 0
  if (!caip || !TOKEN_NAMESPACE_RE.test(caip)) return finiteAmount(balance.balance)
  const wanted = normalizeAssetCaip(caip)
  const token = balance.tokens?.find((candidate) => normalizeAssetCaip(candidate.caip) === wanted)
  return finiteAmount(token?.balance)
}

function baselineFor(
  balances: Map<string, ChainBalance>,
  chainId: string,
  assetCaip?: string,
): number {
  return balanceAmountForAsset(balances.get(chainId), assetCaip)
}

export function beginSwapBalanceReconciliation(
  detail: SwapExecutionBalanceDetail,
  balances: Map<string, ChainBalance>,
  now = Date.now(),
): BalanceReconciliation | null {
  if (!detail.txid || detail.isWalletDestination === false) return null
  return {
    txid: detail.txid,
    chainId: detail.toChainId,
    assetCaip: detail.toCaip,
    symbol: detail.toSymbol,
    baselineAmount: baselineFor(balances, detail.toChainId, detail.toCaip),
    expectedOutput: finiteAmount(detail.expectedOutput) || undefined,
    terminal: false,
    observed: false,
    startedAt: now,
    attempts: 0,
  }
}

/**
 * Mark a tracked swap terminal. Refunds reconcile the source asset; successful
 * swaps reconcile the destination asset.
 */
export function completeSwapBalanceReconciliation(
  existing: BalanceReconciliation | undefined,
  swap: PendingSwap,
  balances: Map<string, ChainBalance>,
  now = Date.now(),
): BalanceReconciliation {
  const refunded = swap.status === 'refunded'
  const chainId = refunded ? swap.fromChainId : swap.toChainId
  const assetCaip = refunded ? swap.fromCaip : swap.toCaip
  const symbol = refunded ? swap.fromSymbol : swap.toSymbol
  const sameTarget = existing
    && existing.chainId === chainId
    && normalizeAssetCaip(existing.assetCaip) === normalizeAssetCaip(assetCaip)

  return {
    ...(sameTarget ? existing : {
      txid: swap.txid,
      chainId,
      assetCaip,
      symbol,
      baselineAmount: baselineFor(balances, chainId, assetCaip),
      expectedOutput: finiteAmount(refunded ? swap.fromAmount : (swap.receivedOutput || swap.expectedOutput)) || undefined,
      observed: false,
      startedAt: now,
      attempts: 0,
    }),
    terminal: true,
    completedAt: now,
  }
}

/**
 * Apply a protocol-terminal swap status to the reconciliation collection.
 * Failed swaps have no destination output to observe, so their provisional
 * record must be removed immediately instead of protecting a chain forever.
 */
export function reconcileTerminalSwapBalance(
  records: BalanceReconciliation[],
  swap: PendingSwap,
  balances: Map<string, ChainBalance>,
  now = Date.now(),
): BalanceReconciliation[] {
  if (swap.status === 'failed') {
    return records.filter((record) => record.txid !== swap.txid)
  }
  if (swap.status !== 'completed' && swap.status !== 'refunded') return records

  const existing = records.find((record) => record.txid === swap.txid)
  const completed = completeSwapBalanceReconciliation(existing, swap, balances, now)
  return [
    ...records.filter((record) => record.txid !== completed.txid),
    completed,
  ]
}

function hasObservedIncrease(record: BalanceReconciliation, observedAmount: number): boolean {
  const tolerance = Math.max(1e-12, Math.abs(record.baselineAmount) * 1e-12)
  return observedAmount > record.baselineAmount + tolerance
}

/**
 * Expire terminal reconciliation records solely from wall-clock time. This is
 * intentionally independent of balance refreshes: an offline/failed indexer
 * must not be able to keep a protected snapshot and spinner alive forever.
 */
export function expireBalanceReconciliations(
  records: BalanceReconciliation[],
  now = Date.now(),
): BalanceReconciliation[] {
  let changed = false
  const next = records.map((record) => {
    const since = record.completedAt ?? record.startedAt
    if (
      record.terminal
      && !record.observed
      && !record.expired
      && now >= since + RECONCILIATION_CEILING_MS
    ) {
      changed = true
      return { ...record, expired: true }
    }
    return record
  })
  return changed ? next : records
}

/**
 * Apply a portfolio response to the reconciliation records. A degraded or
 * stale chain is not proof: it may be exactly the lagging snapshot that caused
 * the missing-funds scare.
 */
export function observeBalanceRefresh(
  records: BalanceReconciliation[],
  refreshed: ChainBalance[],
  now = Date.now(),
): BalanceReconciliation[] {
  const byChain = new Map(refreshed.map((balance) => [balance.chainId, balance]))
  const next: BalanceReconciliation[] = []

  for (const record of records) {
    const balance = byChain.get(record.chainId)
    const wantedCaip = normalizeAssetCaip(record.assetCaip)
    const assetDirectlyConfirmed = !!balance?.confirmedAssetCaips?.some(
      (caip) => normalizeAssetCaip(caip) === wantedCaip,
    )
    const reliable = balance && (
      assetDirectlyConfirmed
      || (balance.syncState !== 'degraded' && balance.syncState !== 'stale')
    )
    const observedAmount = reliable
      ? balanceAmountForAsset(balance, record.assetCaip)
      : record.lastObservedAmount
    const observed = record.observed
      || (observedAmount !== undefined && hasObservedIncrease(record, observedAmount))
    const updated: BalanceReconciliation = {
      ...record,
      observed,
      attempts: record.attempts + (balance ? 1 : 0),
      ...(observedAmount !== undefined ? { lastObservedAmount: observedAmount } : {}),
    }

    // Once the protocol is terminal AND the wallet balance independently shows
    // the increase, the panic window is closed.
    if (updated.terminal && updated.observed) continue
    next.push(updated)
  }

  return expireBalanceReconciliations(next, now)
}

/**
 * Chains whose new response must not replace the last trusted snapshot yet.
 * Expired records have given up waiting — they no longer protect, so the real
 * (possibly still-lagging) balance can surface behind a dismissible notice.
 */
export function protectedBalanceChainIds(records: BalanceReconciliation[]): Set<string> {
  return new Set(
    records.filter((record) => !record.observed && !record.expired).map((record) => record.chainId),
  )
}

/**
 * Stale-while-revalidate merge gate. An incomplete response can explain why
 * syncing continues, but it cannot erase a snapshot the wallet already showed.
 */
export function shouldReplaceBalanceSnapshot(
  existing: ChainBalance | undefined,
  incoming: ChainBalance,
  protectedByReconciliation: boolean,
): boolean {
  if (!existing) return true
  if (protectedByReconciliation) return false
  return incoming.syncState !== 'degraded' && incoming.syncState !== 'stale'
}

/**
 * Merge a refresh at the narrowest trustworthy scope. A clean chain replaces
 * the row. A stale/degraded chain may still carry assets independently proven
 * by direct RPC; merge only those tokens and preserve everything else.
 */
export function mergeTrustedBalanceSnapshot(
  existing: ChainBalance | undefined,
  incoming: ChainBalance,
  protectedByReconciliation: boolean,
): ChainBalance | undefined {
  if (shouldReplaceBalanceSnapshot(existing, incoming, protectedByReconciliation)) return incoming
  if (!existing || protectedByReconciliation || !incoming.confirmedAssetCaips?.length) return existing

  const confirmed = new Set(incoming.confirmedAssetCaips.map(normalizeAssetCaip))
  const currentTokens = [...(existing.tokens || [])]
  let balanceUsdDelta = 0
  let changed = false
  for (const token of incoming.tokens || []) {
    if (!confirmed.has(normalizeAssetCaip(token.caip))) continue
    const index = currentTokens.findIndex(item =>
      normalizeAssetCaip(item.caip) === normalizeAssetCaip(token.caip))
    if (index >= 0) {
      balanceUsdDelta += (token.balanceUsd || 0) - (currentTokens[index].balanceUsd || 0)
      currentTokens[index] = token
    } else {
      currentTokens.push(token)
      balanceUsdDelta += token.balanceUsd || 0
    }
    changed = true
  }
  if (!changed) return existing

  return {
    ...existing,
    tokens: currentTokens,
    balanceUsd: Math.max(0, (existing.balanceUsd || 0) + balanceUsdDelta),
    confirmedAssetCaips: [
      ...new Set([...(existing.confirmedAssetCaips || []), ...incoming.confirmedAssetCaips]),
    ],
  }
}
