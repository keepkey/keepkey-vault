/** How long one chain waits before retrying after a failed refresh (KEEPKEY-109).
 *
 * A provider limit on one chain (e.g. TRON history returning 429) must neither stall the other chains nor be retried
 * in a tight loop, which only prolongs the limit. Each key backs off on its own: the delays grow per consecutive
 * failure up to a short cap, so a recovered chain is picked up within minutes, and one success resets it.
 *
 * Pure bookkeeping: no timers, no I/O. The caller schedules the retry with the returned delay. */

/** Consecutive failure 1 waits ~5 s, 2 ~15 s, 3 ~30 s, 4 ~60 s, then ~120 s for every later failure. */
export const CHAIN_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000, 120_000]
/** ±20%, so chains that failed together do not retry in lockstep. */
export const CHAIN_RETRY_JITTER = 0.2

export interface ChainBackoff {
  /** Records one more consecutive failure for `key` and returns how long to wait before retrying it. */
  fail(key: string): number
  /** The wait for `key`'s current failure count, without recording a failure (0 when healthy). */
  peek(key: string): number
  /** A success resets `key`, so its next failure starts again from the shortest delay. */
  succeed(key: string): void
  /** Consecutive failures recorded for `key` (0 when healthy). */
  failures(key: string): number
  /** Forgets every key (e.g. the wallet changed). */
  clear(): void
}

export function createChainBackoff(options: { delays?: readonly number[]; jitter?: number; random?: () => number } = {}): ChainBackoff {
  const delays = options.delays ?? CHAIN_RETRY_DELAYS_MS
  const jitter = options.jitter ?? CHAIN_RETRY_JITTER
  const random = options.random ?? Math.random
  if (!delays.length || delays.some(delay => !Number.isFinite(delay) || delay < 0)) throw new Error('Chain backoff needs non-negative delays')
  if (!(jitter >= 0 && jitter < 1)) throw new Error('Chain backoff jitter must be in [0, 1)')
  const counts = new Map<string, number>()
  const delayFor = (count: number) => {
    if (count <= 0) return 0
    const base = delays[Math.min(count, delays.length) - 1]!
    // random() in [0, 1) maps to a factor in [1 - jitter, 1 + jitter).
    return Math.round(base * (1 - jitter + 2 * jitter * random()))
  }
  return {
    fail(key) {
      const count = (counts.get(key) ?? 0) + 1
      counts.set(key, count)
      return delayFor(count)
    },
    peek(key) { return delayFor(counts.get(key) ?? 0) },
    succeed(key) { counts.delete(key) },
    failures(key) { return counts.get(key) ?? 0 },
    clear() { counts.clear() },
  }
}
