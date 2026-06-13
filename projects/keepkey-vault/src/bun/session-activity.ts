/**
 * In-memory activity store for hidden (passphrase) wallet sessions.
 *
 * PRIVACY: hidden-wallet history must leave zero disk trace, but the server
 * lookup itself only needs an address — so scanChainHistory fetches live
 * (rebuildActivityHistory dryRun + collectRows) and parks the rows here.
 * getRecentActivity serves them back for hidden sessions instead of api_log.
 *
 * Cleared on needs_passphrase / disconnect / seed-changed (see index.ts) so
 * rows never outlive the session they belong to.
 */
import type { RecentActivity } from '../shared/types'

const rows = new Map<string, RecentActivity>()

/** Add rows (deduped by chain+txid). Returns how many were new. */
export function addSessionActivity(items: RecentActivity[]): number {
  let added = 0
  for (const item of items) {
    const key = `${item.chainId || item.chain}:${item.txid || item.id}`
    if (!rows.has(key)) added++
    rows.set(key, item)
  }
  return added
}

/** Newest-first session rows; chainFilter matches chain id or symbol
 *  (same loose semantics as getRecentActivityFromLog's chain filter). */
export function getSessionActivity(limit = 50, chainFilter?: string): RecentActivity[] {
  let list = Array.from(rows.values())
  if (chainFilter) list = list.filter(r => r.chainId === chainFilter || r.chain === chainFilter)
  return list.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
}

export function clearSessionActivity(): void {
  rows.clear()
}
