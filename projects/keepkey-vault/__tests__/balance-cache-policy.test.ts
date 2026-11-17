// Pure cache-age rules; no wallet, device, database or network.
import { describe, expect, test } from 'bun:test'
import { BALANCE_CACHE_QUIET_WINDOW_MS, oldestBalanceUpdatedAt, usableCachedBalance } from '../src/shared/balance-cache-policy'

const now = 2 * BALANCE_CACHE_QUIET_WINDOW_MS
const cached = { balance: '0.125', updatedAt: now - 60_000 }

describe('quiet balance cache', () => {
  test('valid legacy, confirmed, zero and exponent-form amounts remain usable for less than a day', () => {
    for (const balance of ['0', '0.125', '1e-8', '1.000000000000000001']) {
      expect(usableCachedBalance({ ...cached, balance }, now)).toBe(true)
      expect(usableCachedBalance({ ...cached, balance, syncState: 'confirmed' }, now)).toBe(true)
    }
    expect(usableCachedBalance({ ...cached, updatedAt: now - BALANCE_CACHE_QUIET_WINDOW_MS + 1 }, now)).toBe(true)
    expect(usableCachedBalance({ ...cached, updatedAt: now - BALANCE_CACHE_QUIET_WINDOW_MS }, now)).toBe(false)
  })

  test('known transaction marks and failures override a recent cache timestamp', () => {
    expect(usableCachedBalance({ ...cached, syncState: 'stale' }, now)).toBe(false)
    expect(usableCachedBalance({ ...cached, syncState: 'degraded' }, now)).toBe(false)
    expect(usableCachedBalance({ ...cached, txPending: true }, now)).toBe(false)
  })

  test('missing, future or malformed ages and amounts never authorize quiet reuse', () => {
    for (const updatedAt of [undefined, 0, -1, NaN, Infinity, now + 1]) {
      expect(usableCachedBalance({ ...cached, updatedAt }, now)).toBe(false)
    }
    for (const balance of ['', ' ', '-1', 'Infinity', 'NaN', '1e1000', '1,234', '1suffix', '0x10']) {
      expect(usableCachedBalance({ ...cached, balance }, now)).toBe(false)
    }
    expect(usableCachedBalance(undefined, now)).toBe(false)
    expect(usableCachedBalance(null, now)).toBe(false)
  })
})

describe('portfolio age', () => {
  test('the oldest row controls the portfolio timestamp regardless of order', () => {
    expect(oldestBalanceUpdatedAt([{ updatedAt: 200 }, { updatedAt: 100 }, { updatedAt: 300 }])).toBe(100)
    expect(oldestBalanceUpdatedAt([{ updatedAt: 300 }, { updatedAt: 200 }])).toBe(200)
  })

  test('an empty or partially unknown portfolio cannot claim a fresh timestamp', () => {
    expect(oldestBalanceUpdatedAt([])).toBe(0)
    for (const updatedAt of [undefined, 0, -1, NaN, Infinity]) {
      expect(oldestBalanceUpdatedAt([{ updatedAt: 100 }, { updatedAt }])).toBe(0)
    }
  })
})
