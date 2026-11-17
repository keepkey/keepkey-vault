import { expect, test } from 'bun:test'
import { portfolioObservedAt } from '../src/shared/balance-observation'

const readAt = Date.parse('2026-11-16T18:00:00.000Z')
const oldAt = readAt - 86_400_000

test('portfolio observation uses the oldest source timestamp across all native/token rows', () => {
  expect(portfolioObservedAt([{ fetchedAt: readAt - 100 }, { fetchedAt: oldAt }], readAt)).toBe(oldAt)
  expect(portfolioObservedAt([{ fetchedAtISO: new Date(oldAt).toISOString() }, { fetchedAt: readAt }], readAt)).toBe(oldAt)
  expect(portfolioObservedAt([{ fetchedAtISO: '2026-11-15T13:00:00-05:00' }], readAt)).toBe(oldAt)
})

test('future source time and future explicit fallback are capped at the read start', () => {
  expect(portfolioObservedAt([{ fetchedAt: readAt + 60_000 }], readAt)).toBe(readAt)
  expect(portfolioObservedAt([{ fetchedAtISO: new Date(readAt + 60_000).toISOString() }], readAt)).toBe(readAt)
  expect(portfolioObservedAt([{}], readAt, readAt + 60_000)).toBe(readAt)
})

test('conflicting numeric and ISO source timestamps keep the older observation', () => {
  expect(portfolioObservedAt([{ fetchedAt: readAt, fetchedAtISO: new Date(oldAt).toISOString() }], readAt)).toBe(oldAt)
})

test('a cache-only row with missing age remains unknown unless a prior observation exists', () => {
  for (const row of [{}, null, undefined, { fetchedAt: 0 }, { fetchedAt: -1 }, { fetchedAt: NaN }, { fetchedAt: Infinity },
    { fetchedAt: String(readAt) }, { fetchedAtISO: 'not a timestamp' }, { fetchedAtISO: '2026' }]) {
    expect(portfolioObservedAt([row], readAt)).toBeUndefined()
    expect(portfolioObservedAt([row], readAt, oldAt)).toBe(oldAt)
  }
})

test('one missing-age row cannot borrow freshness from another row', () => {
  expect(portfolioObservedAt([{ fetchedAt: readAt }, {}], readAt)).toBeUndefined()
  expect(portfolioObservedAt([{ fetchedAt: readAt }, {}], readAt, oldAt)).toBe(oldAt)
  // Legacy on-demand reads may explicitly use their own read start.
  expect(portfolioObservedAt([{ fetchedAt: readAt }, {}], readAt, readAt)).toBe(readAt)
})

test('empty portfolio responses never establish a fresh observation, even with a fallback', () => {
  expect(portfolioObservedAt([], readAt)).toBeUndefined()
  expect(portfolioObservedAt([], readAt, readAt)).toBeUndefined()
  expect(portfolioObservedAt([], readAt, oldAt)).toBeUndefined()
})

test('invalid read/fallback times cannot invent an observation', () => {
  for (const at of [0, -1, NaN, Infinity]) {
    expect(portfolioObservedAt([{ fetchedAt: oldAt }], at)).toBeUndefined()
    expect(portfolioObservedAt([{}], readAt, at)).toBeUndefined()
  }
})

test('a valid ISO timestamp can supply age when the numeric field is invalid', () => {
  expect(portfolioObservedAt([{ fetchedAt: NaN, fetchedAtISO: new Date(oldAt).toISOString() }], readAt)).toBe(oldAt)
})
