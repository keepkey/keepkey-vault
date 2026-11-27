/** KEEPKEY-109: per-chain retry delays after a failed refresh. */
import { expect, test } from 'bun:test'
import { CHAIN_RETRY_DELAYS_MS, CHAIN_RETRY_JITTER, createChainBackoff } from '../src/bun/chain-backoff'

test('delays grow per consecutive failure and stay at a short cap', () => {
  const backoff = createChainBackoff({ jitter: 0 })
  expect(Array.from({ length: 8 }, () => backoff.fail('tron'))).toEqual([5_000, 15_000, 30_000, 60_000, 120_000, 120_000, 120_000, 120_000])
  expect(backoff.failures('tron')).toBe(8)
  expect(Math.max(...CHAIN_RETRY_DELAYS_MS)).toBe(120_000)
})

test('one success resets a chain to the shortest delay', () => {
  const backoff = createChainBackoff({ jitter: 0 })
  backoff.fail('tron'); backoff.fail('tron'); backoff.fail('tron')
  backoff.succeed('tron')
  expect(backoff.failures('tron')).toBe(0)
  expect(backoff.fail('tron')).toBe(5_000)
})

test('chains back off independently, and clear() forgets them all', () => {
  const backoff = createChainBackoff({ jitter: 0 })
  backoff.fail('tron'); backoff.fail('tron')
  expect(backoff.fail('bitcoin')).toBe(5_000)
  expect(backoff.fail('tron')).toBe(30_000)
  backoff.clear()
  expect([backoff.failures('tron'), backoff.failures('bitcoin')]).toEqual([0, 0])
})

test('jitter spreads each delay within ±20% so chains failing together do not retry in lockstep', () => {
  const at = (random: number) => createChainBackoff({ random: () => random }).fail('tron')
  expect(CHAIN_RETRY_JITTER).toBe(0.2)
  expect(at(0)).toBe(4_000)
  expect(at(0.5)).toBe(5_000)
  expect(at(0.999999)).toBe(6_000)
  for (let i = 0; i < 200; i++) {
    const delay = createChainBackoff().fail('tron')
    expect(delay).toBeGreaterThanOrEqual(4_000); expect(delay).toBeLessThanOrEqual(6_000)
  }
})

test('peek tells the current wait without counting a new failure', () => {
  const backoff = createChainBackoff({ jitter: 0 })
  expect(backoff.peek('tron')).toBe(0)
  backoff.fail('tron'); backoff.fail('tron')
  expect([backoff.peek('tron'), backoff.peek('tron'), backoff.failures('tron')]).toEqual([15_000, 15_000, 2])
  for (let i = 0; i < 6; i++) backoff.fail('tron')
  expect(backoff.peek('tron')).toBe(120_000)
})

test('invalid configurations are refused', () => {
  expect(() => createChainBackoff({ delays: [] })).toThrow('non-negative delays')
  expect(() => createChainBackoff({ delays: [5_000, -1] })).toThrow('non-negative delays')
  expect(() => createChainBackoff({ delays: [Number.NaN] })).toThrow('non-negative delays')
  expect(() => createChainBackoff({ jitter: 1 })).toThrow('jitter')
  expect(() => createChainBackoff({ jitter: -0.1 })).toThrow('jitter')
})
