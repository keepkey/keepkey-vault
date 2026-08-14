/**
 * The dashboard must never assert a balance it was not given.
 *
 * The failure this locks: getBalances RESOLVES on a partial portfolio response
 * (src/bun/index.ts — "failed chains will show 0"), so `loadingBalances` is
 * already false when those rows render. A two-state loading/loaded predicate
 * therefore renders "0 ETH" for a chain nobody successfully queried, and
 * because a cache exists the Pioneer error banner is deferred by
 * PIONEER_ERROR_GRACE_MS (5 minutes) — up to five minutes of unaccompanied,
 * confident, wrong zero.
 *
 * Run: bun test __tests__/balance-display-state.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { balanceDisplayState } from '../src/shared/balance-display-state'

const base = { loadingBalances: false, initialLoaded: true }

describe('balanceDisplayState', () => {
  // ── pending: an answer is genuinely still in flight ──
  test('cold start, nothing loaded yet -> pending', () => {
    expect(balanceDisplayState({ hasEntry: false, loadingBalances: false, initialLoaded: false })).toBe('pending')
  })

  test('refresh in flight, no entry yet -> pending', () => {
    expect(balanceDisplayState({ hasEntry: false, loadingBalances: true, initialLoaded: true })).toBe('pending')
  })

  test('refresh in flight but we already have a value -> known (stale-while-revalidate)', () => {
    // Do not blank out a good number just because a refresh started.
    expect(balanceDisplayState({ hasEntry: true, loadingBalances: true, initialLoaded: true })).toBe('known')
  })

  // ── known: we have a real figure, including a real zero ──
  test('a verified zero is KNOWN, not unknown — an empty wallet is a fact', () => {
    expect(balanceDisplayState({ hasEntry: true, syncState: 'confirmed', ...base })).toBe('known')
  })

  test('no syncState (cached / legacy row) is known, not unknown', () => {
    // syncState is optional; absent means "nobody flagged this", not "untrusted".
    // Treating undefined as unknown would blank every cached row on startup.
    expect(balanceDisplayState({ hasEntry: true, ...base })).toBe('known')
  })

  test("'stale' is a real number that is merely old -> known", () => {
    expect(balanceDisplayState({ hasEntry: true, syncState: 'stale', ...base })).toBe('known')
  })

  // ── unknown: the cases the two-state predicate got wrong ──
  test('settled with no entry (chunk failed / chain omitted) -> unknown, NOT zero', () => {
    expect(balanceDisplayState({ hasEntry: false, ...base })).toBe('unknown')
  })

  test('entry present but backend flagged it degraded -> unknown', () => {
    expect(balanceDisplayState({ hasEntry: true, syncState: 'degraded', ...base })).toBe('unknown')
  })

  test('a degraded row reading 0 is still unknown — the zero is not evidence', () => {
    // This is the exact shape that rendered "0 ETH" for an unreachable chain.
    expect(balanceDisplayState({ hasEntry: true, syncState: 'degraded', ...base })).not.toBe('known')
  })

  // ── liveness: no state spins forever ──
  test('once settled, nothing is pending — a degraded chain resolves to unknown, not a permanent spinner', () => {
    for (const syncState of ['confirmed', 'stale', 'degraded', undefined] as const) {
      expect(balanceDisplayState({ hasEntry: true, syncState, ...base })).not.toBe('pending')
    }
    expect(balanceDisplayState({ hasEntry: false, ...base })).not.toBe('pending')
  })
})
