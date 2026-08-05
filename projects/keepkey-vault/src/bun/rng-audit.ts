/**
 * RNG health testing — pull entropy from the device and check it for the
 * failure modes that output analysis can actually detect.
 *
 * SCOPE, stated plainly because it is easy to overclaim: these are HEALTH
 * tests, not an entropy measurement. A cryptographically strong PRNG seeded
 * with only 40 bits of state passes every test in this file by construction —
 * which is exactly the Coldcard failure class. Random-looking output cannot
 * bound the generator's internal state entropy. What this DOES catch: stuck or
 * repeated output, duplicated blocks, gross bias, broken transport/caching,
 * and a collision detector that silently does nothing.
 *
 * The collision test is the positive control and it is the reason sample size
 * matters. Expected 32-bit collisions are N^2/2^33, so:
 *   64 KB  -> 0.03 expected  (control CANNOT run; a zero result proves nothing)
 *    1 MB  -> 8 expected
 *    8 MB  -> 512 expected   (first size where the result carries information)
 */

import { createHash } from 'crypto'

import type { RngAuditReport, RngAuditStats, RngCheck, RngCheckStatus } from '../shared/types'

export type { RngAuditReport, RngAuditStats, RngCheck, RngCheckStatus }

/**
 * Largest chunk we will ask for. The device caps the reply at its own
 * compiled `Entropy.entropy` max_size and simply returns fewer bytes, so the
 * real limit is discovered at runtime rather than assumed:
 *
 *   firmware with 2f9269f64 (the 7.15 RNG work) -> 8192
 *   everything older                            -> 1024
 *
 * Asking for 8192 and adapting to a short FIRST reply gets 8x the throughput
 * on current firmware while still working on old devices. hdwallet's
 * getEntropy() is one message per call with no chunking of its own.
 */
export const MAX_CHUNK_BYTES = 8192

/** Floor for the adaptive probe — every shipped firmware allows at least this. */
export const MIN_CHUNK_BYTES = 1024

/**
 * Firmware grants this much entropy per boot with no button press. Past it,
 * every request needs a physical confirmation, so a large pull becomes a
 * button-mashing exercise until firmware ships the bulk-audit unlock.
 */
export const PRESS_FREE_BUDGET_BYTES = 64 * 1024

/**
 * Analyse a collected sample. Pure and synchronous, so the scoring is testable
 * without a device (see rng-audit.test.ts).
 */
export function analyzeEntropy(sample: Uint8Array, sampleSha256: string): RngAuditReport {
  const n = sample.length
  if (n === 0) throw new Error('analyzeEntropy: empty sample')

  const freq = new Float64Array(256)
  for (let i = 0; i < n; i++) freq[sample[i]]++

  let ones = 0
  for (let i = 0; i < n; i++) {
    let b = sample[i]
    while (b) { ones += b & 1; b >>= 1 }
  }

  let shannon = 0
  let distinct = 0
  let chi = 0
  const expectedPerValue = n / 256
  for (let v = 0; v < 256; v++) {
    const c = freq[v]
    if (c > 0) { distinct++; const p = c / n; shannon -= p * Math.log2(p) }
    const d = c - expectedPerValue
    chi += (d * d) / expectedPerValue
  }

  let longestRun = 0
  let run = 0
  let prevBit = -1
  for (let i = 0; i < n; i++) {
    for (let k = 7; k >= 0; k--) {
      const bit = (sample[i] >> k) & 1
      if (bit === prevBit) run++
      else { run = 1; prevBit = bit }
      if (run > longestRun) longestRun = run
    }
  }

  // Non-overlapping block scans. 8-byte repeats should never occur; 4-byte
  // collisions should occur at a predictable rate and are the positive control.
  const seen8 = new Set<string>()
  let repeated8 = 0
  const blocks8 = Math.floor(n / 8)
  for (let i = 0; i < blocks8; i++) {
    const key = Buffer.from(sample.buffer, sample.byteOffset + i * 8, 8).toString('latin1')
    if (seen8.has(key)) repeated8++
    else seen8.add(key)
  }

  const seen4 = new Set<number>()
  let collisions4 = 0
  const blocks4 = Math.floor(n / 4)
  const view = new DataView(sample.buffer, sample.byteOffset, sample.byteLength)
  for (let i = 0; i < blocks4; i++) {
    const v = view.getUint32(i * 4, true)
    if (seen4.has(v)) collisions4++
    else seen4.add(v)
  }
  const expected4 = (blocks4 * blocks4) / 2 ** 33

  const stats: RngAuditStats = {
    bytes: n,
    shannonBitsPerByte: shannon,
    onesFraction: ones / (n * 8),
    chiSquare: chi,
    longestBitRun: longestRun,
    distinctBytes: distinct,
    repeatedBlocks8: repeated8,
    collisions4,
    expectedCollisions4: expected4,
    // Below ~1 expected collision a zero result is indistinguishable from a
    // detector that does nothing, so refuse to present it as evidence.
    collisionControlUsable: expected4 >= 1,
  }

  // Every check reports pass / fail / not-run. A check whose sample is too
  // small is NOT a pass -- saying so would put a green tick on evidence that
  // was never gathered, which is the most misleading thing this code could do.
  const checks: RngCheck[] = []
  const add = (id: string, label: string, status: RngCheckStatus, detail: string) =>
    checks.push({ id, label, status, detail })

  add('repeated-blocks', 'Repeated blocks',
    repeated8 > 0 ? 'fail' : 'pass',
    repeated8 > 0
      ? `${repeated8} repeated 8-byte block(s) — the RNG is stuck or output is being replayed`
      : 'No 8-byte block occurred twice')

  if (n >= 4096) {
    add('byte-coverage', 'Byte coverage', distinct < 256 ? 'fail' : 'pass',
      distinct < 256 ? `only ${distinct}/256 byte values observed` : 'All 256 byte values seen')
  } else {
    add('byte-coverage', 'Byte coverage', 'not-run', 'Needs at least 4 KB')
  }

  if (n >= 65536) {
    // Chi-square 5% critical value for 255 dof is ~293.2; 0.1% is ~330.5. Use
    // the looser bound so a healthy device does not trip on ordinary variance.
    add('chi-square', 'Byte distribution', chi > 330.5 ? 'fail' : 'pass',
      chi > 330.5
        ? `chi-square ${chi.toFixed(1)} exceeds the 0.1% critical value (330.5)`
        : `chi-square ${chi.toFixed(1)}, within expected variation`)

    const bias = Math.abs(stats.onesFraction - 0.5)
    add('bit-balance', 'Bit balance', bias > 0.01 ? 'fail' : 'pass',
      bias > 0.01
        ? `bit balance ${stats.onesFraction.toFixed(4)} is more than 1% off 0.5`
        : `${stats.onesFraction.toFixed(5)} of bits set`)

    add('longest-run', 'Longest run', longestRun > 64 ? 'fail' : 'pass',
      longestRun > 64
        ? `longest identical-bit run is ${longestRun}`
        : `${longestRun} identical bits, unremarkable`)
  } else {
    add('chi-square', 'Byte distribution', 'not-run', 'Needs at least 64 KB')
    add('bit-balance', 'Bit balance', 'not-run', 'Needs at least 64 KB')
    add('longest-run', 'Longest run', 'not-run', 'Needs at least 64 KB')
  }

  if (stats.collisionControlUsable) {
    // Poisson-ish; flag only a gross departure in either direction. Far too few
    // collisions is as suspicious as too many — it can mean the detector is
    // broken or the stream is a permutation rather than random draws.
    const lo = expected4 / 4
    const hi = expected4 * 4
    const bad = collisions4 < lo || collisions4 > hi
    add('collision-control', 'Collision control', bad ? 'fail' : 'pass',
      bad
        ? `4-byte collisions ${collisions4} far from the expected ${expected4.toFixed(1)} — positive control failed`
        : `${collisions4} observed vs ${expected4.toFixed(0)} expected — the detector demonstrably works`)
  } else {
    add('collision-control', 'Collision control', 'not-run',
      `Only ${expected4.toFixed(2)} collisions expected at this size, so a zero result would prove nothing. Needs about 1 MB.`)
  }

  // Linear complexity. For random bits this sits within a couple of units of
  // bits/2 -- the distribution is famously tight (variance ~1.06), so a
  // threshold 100 below the mean is ~100 sigma and cannot false-positive,
  // while a free-running LFSR lands two orders of magnitude below it.
  if (n * 8 >= LINEAR_COMPLEXITY_BITS) {
    const lc = linearComplexity(toBits(sample, LINEAR_COMPLEXITY_BITS))
    const floor = LINEAR_COMPLEXITY_BITS / 2 - 100
    add('linear-complexity', 'Linear complexity', lc < floor ? 'fail' : 'pass',
      lc < floor
        ? `shortest generating LFSR is ${lc} bits for a ${LINEAR_COMPLEXITY_BITS}-bit sample ` +
          `(expected ~${LINEAR_COMPLEXITY_BITS / 2}) — the stream is a linear recurrence and predictable`
        : `${lc} of an expected ~${LINEAR_COMPLEXITY_BITS / 2} — no linear recurrence`)
  } else {
    add('linear-complexity', 'Linear complexity', 'not-run',
      `Needs at least ${LINEAR_COMPLEXITY_BITS / 8} bytes`)
  }

  const failures = checks.filter((c) => c.status === 'fail').map((c) => c.detail)

  return {
    stats,
    checks,
    failures,
    sampleSha256,
    verdict: failures.length === 0 ? 'healthy' : 'failed',
  }
}

/** Human-readable, deliberately non-overclaiming summary for the UI. */
export function verdictSummary(report: RngAuditReport): string {
  const kb = (report.stats.bytes / 1024).toFixed(0)
  if (report.verdict === 'failed') {
    return `FAILED — ${report.failures.length} check(s) failed on ${kb} KB.`
  }
  const control = report.stats.collisionControlUsable
    ? `The collision positive control ran (${report.stats.collisions4} observed vs ` +
      `${report.stats.expectedCollisions4.toFixed(1)} expected), so the detector is known to work.`
    : `The sample is too small for the collision positive control to mean anything ` +
      `(${report.stats.expectedCollisions4.toFixed(2)} expected) — a larger pull is needed for that check to carry information.`
  return (
    `No stuck, repeated, or grossly biased output detected in ${kb} KB. ${control} ` +
    `This does NOT measure how much entropy the generator's internal state holds, ` +
    `and cannot rule out a low-entropy seed expanded by a strong PRNG.`
  )
}

/**
 * Pull `totalBytes` of entropy from the device in MAX_CHUNK_BYTES requests and
 * analyse the result.
 *
 * Sizing reality on current firmware: the device grants PRESS_FREE_BUDGET_BYTES
 * per boot with no confirmation, then requires a physical button press for
 * EVERY subsequent request. At 1 KB per request that makes anything past 64 KB
 * a button-mashing exercise, which is why the UI defaults to the press-free
 * budget. Firmware PR #338 changes the bulk path to one press -> unmetered on
 * an uninitialized device; when that ships, larger pulls become practical and
 * the collision positive control finally carries information.
 */
export async function collectAndAnalyze(
  getEntropy: (size: number) => Promise<Uint8Array>,
  totalBytes: number,
  onProgress?: (collected: number, total: number) => void,
): Promise<RngAuditReport> {
  if (!Number.isInteger(totalBytes) || totalBytes <= 0) {
    throw new Error(`invalid entropy size: ${totalBytes}`)
  }
  const hash = createHash('sha256')
  const sample = new Uint8Array(totalBytes)
  let collected = 0
  let chunkBytes = Math.min(MAX_CHUNK_BYTES, totalBytes)

  while (collected < totalBytes) {
    const want = Math.min(chunkBytes, totalBytes - collected)
    const chunk = await getEntropy(want)

    if (!(chunk instanceof Uint8Array) || chunk.length === 0) {
      throw new Error(`device returned no entropy for a ${want}-byte request (collected ${collected}/${totalBytes})`)
    }

    if (chunk.length !== want) {
      // A short reply on the FIRST call is the device telling us its cap --
      // older firmware maxes at 1024. Adopt it and keep the bytes. A short
      // reply later is a genuine anomaly and must not be papered over, since
      // analysing padded or truncated data would invent a result.
      const isFirstCall = collected === 0
      if (isFirstCall && chunk.length >= MIN_CHUNK_BYTES && chunk.length < want) {
        chunkBytes = chunk.length
      } else {
        throw new Error(
          `device returned ${chunk.length} bytes for a ${want}-byte request ` +
          `(collected ${collected}/${totalBytes})`,
        )
      }
    }

    sample.set(chunk, collected)
    hash.update(chunk)
    collected += chunk.length
    onProgress?.(collected, totalBytes)
  }

  const report = analyzeEntropy(sample, hash.digest('hex'))
  return { ...report, chunkBytes }
}

/**
 * Berlekamp–Massey linear complexity over GF(2).
 *
 * Returns the length of the shortest LFSR that generates `bits`. This matters
 * to us specifically because we apply NO software conditioning: GetEntropy
 * returns STM32 RNG_DR verbatim, which is ring-oscillator noise clocked into
 * an LFSR. If the analog source dies while that LFSR keeps free-running, the
 * output stays uniform, unbiased, collision-correct — and passes every other
 * check in this file — while being a pure linear recurrence that is
 * predictable from ~2L bits.
 *
 * For genuinely random input the expected complexity is ~n/2. For a degraded
 * LFSR of degree L it collapses to L. That gap is enormous and unmissable.
 *
 * NB: a device that hashed its RNG output before returning it would defeat
 * this test entirely — the conditioner would look like maximal complexity no
 * matter what fed it. Our rawness is the asset.
 */
export function linearComplexity(bits: Uint8Array): number {
  const n = bits.length
  const c = new Uint8Array(n)
  const b = new Uint8Array(n)
  c[0] = 1
  b[0] = 1
  let l = 0
  let m = -1

  for (let i = 0; i < n; i++) {
    let d = bits[i]
    for (let j = 1; j <= l; j++) d ^= c[j] & bits[i - j]
    if (d === 0) continue

    const t = c.slice(0, l + 1)
    const shift = i - m
    for (let j = 0; j + shift < n; j++) c[j + shift] ^= b[j]

    if (2 * l <= i) {
      l = i + 1 - l
      m = i
      b.fill(0)
      b.set(t)
    }
  }
  return l
}

/** Unpack the first `count` bits of `bytes`, MSB first. */
export function toBits(bytes: Uint8Array, count: number): Uint8Array {
  const out = new Uint8Array(count)
  for (let i = 0; i < count; i++) out[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1
  return out
}

/** Bits fed to the linear-complexity check. O(n^2), so keep it bounded. */
export const LINEAR_COMPLEXITY_BITS = 4096
