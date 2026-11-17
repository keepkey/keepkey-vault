import { expect, test } from 'bun:test'
import { dashboardBalanceUpdatedAt, dashboardCacheIsQuiet, dashboardErrorNotice, dashboardRefreshIsDue, mergeDashboardPortfolioFault, recoverDashboardPortfolioFault } from '../src/shared/dashboard-balance-policy'
import type { ChainBalance } from '../src/shared/types'
const now = 1_800_000_000_000
const day = 86_400_000
const labels = [{ id: 'bitcoin', symbol: 'BTC' }, { id: 'ethereum', symbol: 'ETH' }, { id: 'base', symbol: 'ETH' }]
const row = (chainId: string, age: number, patch: Partial<ChainBalance> = {}): ChainBalance => ({ chainId, symbol: 'TEST', balance: '1', balanceUsd: 1, address: 'public-fixture', updatedAt: now - age, syncState: 'confirmed', ...patch })
const failure = { degradedChains: ['BTC', 'ETH'], degradedChainIds: ['bitcoin', 'ethereum'], staleChains: [], staleChainIds: [], unresolvedFaultCount: 0 }

test('the refresh age uses the oldest visible figure and never invents a fresh timestamp', () => {
  expect(dashboardBalanceUpdatedAt([row('bitcoin', 0), row('ethereum', day)], null, now)).toBe(now - day)
  expect(dashboardBalanceUpdatedAt([row('bitcoin', 0, { updatedAt: undefined })], null, now)).toBeNull()
  expect(dashboardBalanceUpdatedAt([row('bitcoin', 0), undefined], null, now)).toBeNull()
  expect(dashboardBalanceUpdatedAt([row('bitcoin', 0), row('ethereum', day, { syncState: 'degraded' })], null, now)).toBeNull()
  expect(dashboardBalanceUpdatedAt([row('bitcoin', 0), row('ethereum', 0, { updatedAt: 0 })], now, now)).toBeNull()
  expect(dashboardBalanceUpdatedAt([row('bitcoin', 0, { updatedAt: now + 1 })], null, now)).toBeNull()
  expect(dashboardBalanceUpdatedAt([row('bitcoin', 0, { updatedAt: undefined })], now - 60_000, now)).toBe(now - 60_000)
  expect(dashboardRefreshIsDue(now - day + 1, now)).toBe(false)
  expect(dashboardRefreshIsDue(now - day, now)).toBe(true)
  expect(dashboardRefreshIsDue(null, now)).toBe(false)
})

test('recent ordinary stale cache is quiet; missing/error/known-activity/old data is not', () => {
  const rows = [row('bitcoin', 60_000, { syncState: 'stale' })]
  expect(dashboardCacheIsQuiet(rows, ['bitcoin'], null, new Set(), now)).toBe(true)
  expect(dashboardCacheIsQuiet(rows, ['bitcoin', 'ethereum'], null, new Set(), now)).toBe(false)
  expect(dashboardCacheIsQuiet(rows, ['bitcoin'], null, new Set(['bitcoin']), now)).toBe(false)
  expect(dashboardCacheIsQuiet([row('bitcoin', 60_000, { txPending: true })], ['bitcoin'], null, new Set(), now)).toBe(false)
  expect(dashboardCacheIsQuiet([row('bitcoin', 60_000, { syncState: 'degraded' })], ['bitcoin'], null, new Set(), now)).toBe(false)
  expect(dashboardCacheIsQuiet([row('bitcoin', day)], ['bitcoin'], null, new Set(), now)).toBe(false)
})

test('stale-only reports never become an error banner, including unmapped stale metadata', () => {
  const fault = mergeDashboardPortfolioFault(null, { severity: 'warning', staleChains: ['BTC', 'unknown'], staleChainIds: ['bitcoin'], unresolvedFaultCount: 1, unresolvedErrorCount: 0 }, labels)
  expect(fault?.staleChainIds).toEqual(['bitcoin'])
  expect(dashboardErrorNotice(fault, ['bitcoin'], labels)).toBeNull()
  expect(dashboardErrorNotice(failure, ['bitcoin'], labels)?.names).toEqual(['BTC'])
})

test('a partial success clears only its checked chain, even when symbols collide', () => {
  const remaining = recoverDashboardPortfolioFault(failure, ['bitcoin'], labels)
  expect(remaining?.degradedChainIds).toEqual(['ethereum'])
  expect(dashboardErrorNotice(remaining, ['bitcoin', 'ethereum'], labels)?.names).toEqual(['ETH'])
  const duplicate = { ...failure, degradedChains: ['ETH'], degradedChainIds: ['ethereum', 'base'] }
  expect(recoverDashboardPortfolioFault(duplicate, ['base'], labels)?.degradedChainIds).toEqual(['ethereum'])
  expect(recoverDashboardPortfolioFault(remaining, ['ethereum'], labels)).toBeNull()
})

test('dismissal keys ignore age-only updates but change for distinct errors, preserving unmapped real failures', () => {
  const original = dashboardErrorNotice(failure, ['bitcoin', 'ethereum'], labels)!
  expect(dashboardErrorNotice({ ...failure, staleMinutes: 12 }, ['bitcoin', 'ethereum'], labels)?.key).toBe(original.key)
  expect(dashboardErrorNotice({ ...failure, degradedChainIds: ['bitcoin'], degradedChains: ['BTC'] }, ['bitcoin', 'ethereum'], labels)?.key).not.toBe(original.key)
  const unknown = { ...failure, degradedChains: ['unknown'], degradedChainIds: [], unresolvedFaultCount: 1, unresolvedErrorCount: 1 }
  const recovered = recoverDashboardPortfolioFault(unknown, ['bitcoin'], labels)
  expect(dashboardErrorNotice(recovered, ['bitcoin'], labels)?.names).toEqual(['unknown'])
  expect(mergeDashboardPortfolioFault(recovered, { severity: 'none' }, labels)).toBeNull()
  expect(mergeDashboardPortfolioFault(recovered, { severity: 'none', fullSnapshot: true, checkedChainIds: ['bitcoin'] }, labels)).toBeNull()
  const anonymous = { ...unknown, degradedChains: [] }
  expect(dashboardErrorNotice(recoverDashboardPortfolioFault(anonymous, ['bitcoin'], labels), ['bitcoin'], labels)).not.toBeNull()
  expect(mergeDashboardPortfolioFault(anonymous, { severity: 'none', fullSnapshot: true, checkedChainIds: ['bitcoin'] }, labels)).toBeNull()
})
