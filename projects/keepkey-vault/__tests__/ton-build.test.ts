/**
 * Pure-function tests for TON build/verify flow.
 *
 * These run under `bun test` without a device or a live TonCenter —
 * they cover the tamper-detection path in /ton/finalize-transfer so the
 * regression from the PR review (REST-layer accepts mutated _internal
 * and silently signs over a different body) stays locked down.
 */
import { describe, test, expect } from 'bun:test'
import { buildTonTransfer, computeTonBodyHash } from '../src/bun/txbuilder/ton'

// Raw "workchain:hex" addresses skip CRC16 validation (user-friendly base64
// addresses embed a checksum and would break if drifted). All we need here
// is a 32-byte hash per endpoint; the cell math doesn't care what bytes.
const FROM_ADDR = '0:1111111111111111111111111111111111111111111111111111111111111111'
const SAFE_TO   = '0:2222222222222222222222222222222222222222222222222222222222222222'

describe('TON build → bodyHash round-trip', () => {
  test('computeTonBodyHash matches build.bodyHash for a clean build', () => {
    const build = buildTonTransfer({
      fromAddress: FROM_ADDR,
      to: SAFE_TO,
      amountNano: '1000000000',
      seqno: 7,
      expireAt: 1_700_000_000,
    })

    const recomputed = computeTonBodyHash(build)
    expect(recomputed).toBe(build.bodyHash)
  })

  test('computeTonBodyHash changes when _internal.amountNano is mutated', () => {
    const build = buildTonTransfer({
      fromAddress: FROM_ADDR,
      to: SAFE_TO,
      amountNano: '1000000000',
      seqno: 7,
      expireAt: 1_700_000_000,
    })
    const originalHash = build.bodyHash

    // Simulate a malicious client mutating _internal post-signing
    const tampered = { ...build, _internal: { ...build._internal, amountNano: '9999999999' } }
    const recomputed = computeTonBodyHash(tampered)
    expect(recomputed).not.toBe(originalHash)
  })

  test('computeTonBodyHash changes when _internal.destHash is mutated', () => {
    const build = buildTonTransfer({
      fromAddress: FROM_ADDR,
      to: SAFE_TO,
      amountNano: '1000000000',
      seqno: 7,
      expireAt: 1_700_000_000,
    })
    const originalHash = build.bodyHash

    // Flip a single byte in the destination hash
    const bytes = Buffer.from(build._internal.destHash, 'hex')
    bytes[0] ^= 0x01
    const tampered = { ...build, _internal: { ...build._internal, destHash: bytes.toString('hex') } }
    const recomputed = computeTonBodyHash(tampered)
    expect(recomputed).not.toBe(originalHash)
  })

  test('computeTonBodyHash changes when seqno is mutated', () => {
    const build = buildTonTransfer({
      fromAddress: FROM_ADDR,
      to: SAFE_TO,
      amountNano: '1000000000',
      seqno: 7,
      expireAt: 1_700_000_000,
    })
    const tampered = { ...build, seqno: 8 }
    expect(computeTonBodyHash(tampered)).not.toBe(build.bodyHash)
  })

  test('computeTonBodyHash changes when memo is added', () => {
    const build = buildTonTransfer({
      fromAddress: FROM_ADDR,
      to: SAFE_TO,
      amountNano: '1000000000',
      seqno: 7,
      expireAt: 1_700_000_000,
    })
    const tampered = { ...build, _internal: { ...build._internal, memo: 'stealth-memo' } }
    expect(computeTonBodyHash(tampered)).not.toBe(build.bodyHash)
  })

  test('computeTonBodyHash throws on missing _internal', () => {
    expect(() => computeTonBodyHash({ bodyHash: 'aa' } as any)).toThrow(/_internal/)
  })

  test('computeTonBodyHash throws on malformed destHash hex', () => {
    const build = buildTonTransfer({
      fromAddress: FROM_ADDR,
      to: SAFE_TO,
      amountNano: '1000000000',
      seqno: 7,
      expireAt: 1_700_000_000,
    })
    const bad = { ...build, _internal: { ...build._internal, destHash: 'not-hex' } }
    expect(() => computeTonBodyHash(bad)).toThrow(/destHash/)
  })

  test('computeTonBodyHash throws on non-integer seqno', () => {
    const build = buildTonTransfer({
      fromAddress: FROM_ADDR,
      to: SAFE_TO,
      amountNano: '1000000000',
      seqno: 7,
      expireAt: 1_700_000_000,
    })
    const bad = { ...build, seqno: 'abc' as any }
    expect(() => computeTonBodyHash(bad)).toThrow(/seqno/)
  })

  test('computeTonBodyHash throws on empty amountNano', () => {
    const build = buildTonTransfer({
      fromAddress: FROM_ADDR,
      to: SAFE_TO,
      amountNano: '1000000000',
      seqno: 7,
      expireAt: 1_700_000_000,
    })
    const bad = { ...build, _internal: { ...build._internal, amountNano: '' } }
    expect(() => computeTonBodyHash(bad)).toThrow(/amountNano/)
  })
})
