export const BALANCE_CACHE_QUIET_WINDOW_MS = 24 * 60 * 60 * 1000

interface CachedBalance {
  balance: string
  updatedAt?: number
  syncState?: 'confirmed' | 'stale' | 'degraded'
  txPending?: boolean
}

/** A cached amount may quietly survive reopening; a known error or transaction
 * invalidation may not. Legacy persisted rows have no syncState and are valid. */
export function usableCachedBalance(balance: CachedBalance | null | undefined, now = Date.now()): boolean {
  if (!balance || balance.syncState === 'stale' || balance.syncState === 'degraded' || balance.txPending) return false
  const at = balance.updatedAt
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || !Number.isFinite(now)
    || at > now || now - at >= BALANCE_CACHE_QUIET_WINDOW_MS) return false
  const amount = typeof balance.balance === 'string' ? balance.balance.trim() : ''
  return /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(amount)
    && Number.isFinite(Number(amount)) && Number(amount) >= 0
}

/** A portfolio's timestamp must cover every visible row, not its newest row.
 * An incomplete age is unknown, rather than a claim that the portfolio is fresh. */
export function oldestBalanceUpdatedAt(balances: readonly { updatedAt?: number }[]): number {
  if (!balances.length) return 0
  let oldest = Infinity
  for (const balance of balances) {
    const at = balance.updatedAt
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return 0
    oldest = Math.min(oldest, at)
  }
  return oldest
}
