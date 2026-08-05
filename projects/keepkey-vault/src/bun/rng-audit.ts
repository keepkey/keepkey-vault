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

import type { RngAuditReport, RngAuditStats } from '../shared/types'

export type { RngAuditReport, RngAuditStats }

/**
 * Hard device limit: firmware declares `Entropy.entropy max_size:1024`
 * (messages.options) and hdwallet's getEntropy() is a single message with no
 * chunking, so a larger ask silently comes back short.
 *
 * NOTE: the REST schema (schemas.ts GetEntropyRequest) still allows up to
 * 8192, which can never succeed — rest-api.ts rejects the short reply with
 * "Device returned 1024 entropy bytes; expected N". That mismatch predates
 * this module; it is not something to copy.
 */
export const MAX_CHUNK_BYTES = 1024

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

  const failures: string[] = []
  if (repeated8 > 0) {
    failures.push(`${repeated8} repeated 8-byte block(s) — the RNG is stuck or output is being replayed`)
  }
  if (n >= 4096 && distinct < 256) {
    failures.push(`only ${distinct}/256 byte values observed`)
  }
  // Chi-square 5% critical value for 255 dof is ~293.2; 0.1% is ~330.5. Use
  // the looser bound so a healthy device does not trip on ordinary variance.
  if (n >= 65536 && chi > 330.5) {
    failures.push(`byte distribution chi-square ${chi.toFixed(1)} exceeds the 0.1% critical value (330.5)`)
  }
  if (n >= 65536 && Math.abs(stats.onesFraction - 0.5) > 0.01) {
    failures.push(`bit balance ${stats.onesFraction.toFixed(4)} is more than 1% off 0.5`)
  }
  if (n >= 65536 && longestRun > 64) {
    failures.push(`longest identical-bit run is ${longestRun}`)
  }
  if (stats.collisionControlUsable) {
    // Poisson-ish; flag only a gross departure in either direction. Far too few
    // collisions is as suspicious as too many — it can mean the detector is
    // broken or the stream is a permutation rather than random draws.
    const lo = expected4 / 4
    const hi = expected4 * 4
    if (collisions4 < lo || collisions4 > hi) {
      failures.push(
        `4-byte collisions ${collisions4} far from the expected ${expected4.toFixed(1)} — ` +
        `positive control failed`,
      )
    }
  }

  return {
    stats,
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

  while (collected < totalBytes) {
    const want = Math.min(MAX_CHUNK_BYTES, totalBytes - collected)
    const chunk = await getEntropy(want)
    // Never pad or truncate silently — a short reply means the device or the
    // transport is not doing what we asked, and analysing padded zeros would
    // manufacture a failure (or hide one).
    if (!(chunk instanceof Uint8Array) || chunk.length !== want) {
      throw new Error(
        `device returned ${chunk?.length ?? 0} bytes for a ${want}-byte request ` +
        `(collected ${collected}/${totalBytes})`,
      )
    }
    sample.set(chunk, collected)
    hash.update(chunk)
    collected += want
    onProgress?.(collected, totalBytes)
  }

  return analyzeEntropy(sample, hash.digest('hex'))
}
