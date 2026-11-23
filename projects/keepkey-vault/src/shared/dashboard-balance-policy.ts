import type { ChainBalance } from './types'
import { BALANCE_CACHE_QUIET_WINDOW_MS, oldestBalanceUpdatedAt } from './balance-cache-policy'

export interface DashboardPortfolioFault {
  degradedChains: string[]
  staleChains: string[]
  staleMinutes?: number
  degradedChainIds: string[]
  staleChainIds: string[]
  unresolvedFaultCount: number
  unresolvedErrorCount?: number
}
interface FaultReport extends Partial<DashboardPortfolioFault> {
  severity?: 'warning' | 'none'
  checkedChainIds?: string[]
  fullSnapshot?: boolean
}
type ChainLabel = { id: string; symbol: string }
const unique = (values: string[]) => [...new Set(values)]

/** A real older figure remains displayable. This never upgrades its trust
 * marker or grants permission to spend it. Failed/missing figures stay unknown. */
export function usableDashboardBalance(row: ChainBalance | undefined): row is ChainBalance {
  return !!row && row.syncState !== 'degraded' && typeof row.balance === 'string'
    && /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(row.balance.trim()) && Number.isFinite(Number(row.balance)) && Number(row.balance) >= 0
}

/** The age label describes all usable displayed figures, not the newest row.
 * A legacy aggregate timestamp is a fallback only for rows lacking an as-of. */
export function dashboardBalanceUpdatedAt(rows: readonly (ChainBalance | undefined)[], fallback: number | null = null, now = Date.now()): number | null {
  if (!rows.length || rows.some(row => !usableDashboardBalance(row))) return null
  const timestamps = rows.map(row => ({ updatedAt: row!.updatedAt ?? fallback ?? undefined }))
  if (timestamps.some(row => typeof row.updatedAt === 'number' && row.updatedAt > now)) return null
  const oldest = oldestBalanceUpdatedAt(timestamps)
  return oldest > 0 && oldest <= now ? oldest : null
}

/** OWNER 11-22: the header says when balances last refreshed, not the age of the oldest
 * chain. One chain the server could not refresh must not make the whole wallet read
 * "1d ago" right after a Refresh. Background freshness (dashboardCacheIsQuiet) still
 * requires every visible row to be recent, so that chain keeps being retried. */
export function dashboardLastRefreshedAt(rows: readonly (ChainBalance | undefined)[], fallback: number | null = null, now = Date.now()): number | null {
  let newest = 0
  for (const row of rows) {
    if (!usableDashboardBalance(row)) continue
    const at = row.updatedAt ?? fallback ?? 0
    if (Number.isFinite(at) && at > 0 && at <= now) newest = Math.max(newest, at)
  }
  return newest || null
}

export function dashboardCacheIsQuiet(rows: readonly ChainBalance[], visibleChainIds: readonly string[], fallback: number | null = null, activity: ReadonlySet<string> = new Set(), now = Date.now()): boolean {
  if (!visibleChainIds.length) return false
  const byChain = new Map(rows.map(row => [row.chainId, row]))
  const visible: ChainBalance[] = []
  for (const id of visibleChainIds) {
    const row = byChain.get(id)
    if (!usableDashboardBalance(row) || row.txPending || activity.has(id)) return false
    visible.push(row)
  }
  const updatedAt = dashboardBalanceUpdatedAt(visible, fallback, now)
  return updatedAt !== null && now - updatedAt < BALANCE_CACHE_QUIET_WINDOW_MS
}

export function dashboardRefreshIsDue(updatedAt: number | null, now = Date.now()): boolean {
  return updatedAt !== null && now - updatedAt >= BALANCE_CACHE_QUIET_WINDOW_MS
}

export function confirmedDashboardBalance(row: ChainBalance): boolean {
  return row.syncState === 'confirmed' && !row.txPending
}

function labelsFor(ids: string[], labels: readonly ChainLabel[]): string[] {
  return unique(ids.map(id => labels.find(chain => chain.id === id)?.symbol ?? id))
}
function unmappedNames(names: string[], ids: string[], labels: readonly ChainLabel[]): string[] {
  const mapped = new Set(labelsFor(ids, labels))
  return names.filter(name => !mapped.has(name))
}

/** Partial successes retire only the chains actually checked. Unmapped real
 * errors remain recorded until an authoritative report or wallet reset. */
export function mergeDashboardPortfolioFault(previous: DashboardPortfolioFault | null, report: FaultReport, labels: readonly ChainLabel[]): DashboardPortfolioFault | null {
  if (report.fullSnapshot) previous = null
  if (!report.checkedChainIds) {
    if (report.severity === 'none') return null
    return {
      degradedChains: report.degradedChains ?? [], staleChains: report.staleChains ?? [],
      degradedChainIds: report.degradedChainIds ?? [], staleChainIds: report.staleChainIds ?? [],
      unresolvedFaultCount: report.unresolvedFaultCount ?? 0, unresolvedErrorCount: report.unresolvedErrorCount,
      staleMinutes: report.staleMinutes,
    }
  }
  const checked = new Set(report.checkedChainIds)
  const degradedChainIds = unique([...(previous?.degradedChainIds ?? []).filter(id => !checked.has(id)), ...(report.degradedChainIds ?? [])])
  const staleChainIds = unique([...(previous?.staleChainIds ?? []).filter(id => !checked.has(id)), ...(report.staleChainIds ?? [])])
  const priorUnknownErrors = unmappedNames(previous?.degradedChains ?? [], previous?.degradedChainIds ?? [], labels)
  const degradedChains = unique([...priorUnknownErrors, ...labelsFor(degradedChainIds, labels), ...(report.degradedChains ?? [])])
  const staleChains = unique([...unmappedNames(previous?.staleChains ?? [], previous?.staleChainIds ?? [], labels), ...labelsFor(staleChainIds, labels), ...(report.staleChains ?? [])])
  const unresolvedErrorCount = Math.max(previous?.unresolvedErrorCount ?? priorUnknownErrors.length, report.unresolvedErrorCount ?? 0)
  const unresolvedFaultCount = Math.max(unresolvedErrorCount, previous?.unresolvedFaultCount ?? 0, report.unresolvedFaultCount ?? 0)
  if (!degradedChains.length && !staleChains.length && unresolvedFaultCount === 0) return null
  return { degradedChains, staleChains, degradedChainIds, staleChainIds, unresolvedFaultCount, unresolvedErrorCount, staleMinutes: report.staleMinutes ?? previous?.staleMinutes }
}

export function recoverDashboardPortfolioFault(previous: DashboardPortfolioFault | null, checkedChainIds: string[], labels: readonly ChainLabel[]) {
  return mergeDashboardPortfolioFault(previous, { severity: 'none', checkedChainIds }, labels)
}

/** Ordinary age-only cache reports belong in the refresh control, not a
 * banner. Hidden networks do not create visible errors; unmapped failures do. */
export function dashboardErrorNotice(fault: DashboardPortfolioFault | null, visibleChainIds: readonly string[], labels: readonly ChainLabel[]) {
  if (!fault) return null
  const visible = new Set(visibleChainIds)
  const chainIds = fault.degradedChainIds.filter(id => visible.has(id))
  const unknown = unmappedNames(fault.degradedChains, fault.degradedChainIds, labels)
  const unresolved = fault.unresolvedErrorCount ?? unknown.length
  const names = unique([...labelsFor(chainIds, labels), ...unknown])
  if (!names.length && unresolved === 0) return null
  const identities = [...chainIds.map(id => 'chain:' + id), ...unknown.map(name => 'unmapped:' + name), ...Array.from({ length: unresolved }, (_, index) => 'unresolved:' + index)]
  return { chainIds, names, identities, key: JSON.stringify(identities.slice().sort()) }
}
