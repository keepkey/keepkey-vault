/**
 * Unit tests for the Solana wire-transaction parser in src/bun/solana-tx.ts.
 *
 * These cover:
 *   1. Legacy single- and multi-sig transactions (golden path).
 *   2. Spec-correct v0 versioned transactions: [sigCount][sigs][0x80][msg_v0].
 *   3. The malformed `[0x80][sigCount][sigs][msg]` layout reported against
 *      the REST API — must throw a clear error, never silently pass garbage
 *      through to firmware.
 *   4. Boundary conditions: empty buffer, truncated sigs, unreasonable counts.
 *
 * Run: bun test __tests__/solana-tx.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { parseSolanaTx, SolanaTxParseError, MAX_SIGNATURES } from '../src/bun/solana-tx'

// ── Fixture builders ──────────────────────────────────────────────────

/** Build a minimal legacy tx: [sigCount:1][64*sigCount sigs][legacyMsg]. */
function legacyTx(sigCount: number): Buffer {
  const sigs = Buffer.alloc(64 * sigCount)
  // Legacy message: 3-byte header + 1 account key + 32-byte blockhash + 0 instructions
  const msg = Buffer.concat([
    Buffer.from([1, 0, 0]),       // header: 1 signer, 0 ro-signed, 0 ro-unsigned
    Buffer.from([1]),              // compact-u16 account count (1)
    Buffer.alloc(32),              // static account key (pubkey)
    Buffer.alloc(32),              // recent blockhash
    Buffer.from([0]),              // 0 instructions
  ])
  return Buffer.concat([Buffer.from([sigCount]), sigs, msg])
}

/** Build a spec-correct v0 tx: [sigCount:1][64*sigCount sigs][0x80 msgV0]. */
function versionedV0Tx(sigCount: number): Buffer {
  const sigs = Buffer.alloc(64 * sigCount)
  const msgV0 = Buffer.concat([
    Buffer.from([0x80]),           // v0 prefix — spec puts this INSIDE the message
    Buffer.from([1, 0, 0]),        // header
    Buffer.from([1]),              // accounts compact-u16
    Buffer.alloc(32),              // account
    Buffer.alloc(32),              // blockhash
    Buffer.from([0]),              // 0 instructions
    Buffer.from([0]),              // 0 address-lookup-table entries (v0-only)
  ])
  return Buffer.concat([Buffer.from([sigCount]), sigs, msgV0])
}

/** Build the reported-bug layout: [0x80][sigCount][sigs][msg]. This is NOT
 *  how Solana serializes v0 — the parser must refuse it. */
function malformedPrefixFirstTx(): Buffer {
  return Buffer.concat([
    Buffer.from([0x80]),           // incorrectly placed version prefix
    Buffer.from([1]),              // sigCount
    Buffer.alloc(64),              // sig
    Buffer.from([1, 0, 0]),
    Buffer.from([1]),
    Buffer.alloc(32),
    Buffer.alloc(32),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

// ── Golden path ───────────────────────────────────────────────────────

describe('parseSolanaTx — legacy', () => {
  test('single-sig legacy: strips 1 sig and reports legacy message', () => {
    const tx = legacyTx(1)
    const parsed = parseSolanaTx(tx)
    expect(parsed.sigStart).toBe(1)
    expect(parsed.sigCount).toBe(1)
    expect(parsed.messageStart).toBe(1 + 64)
    expect(parsed.isVersioned).toBe(false)
    expect(tx.subarray(parsed.messageStart)[0]).toBe(1) // first byte of header
  })

  test('multi-sig legacy (3 sigs): messageStart advances past all sigs', () => {
    const tx = legacyTx(3)
    const parsed = parseSolanaTx(tx)
    expect(parsed.sigCount).toBe(3)
    expect(parsed.messageStart).toBe(1 + 3 * 64)
    expect(parsed.isVersioned).toBe(false)
  })
})

// ── Versioned v0 (spec format) ───────────────────────────────────────

describe('parseSolanaTx — v0 (spec-correct)', () => {
  test('detects v0 prefix inside message, after sigs', () => {
    const tx = versionedV0Tx(1)
    const parsed = parseSolanaTx(tx)
    expect(parsed.sigCount).toBe(1)
    expect(parsed.messageStart).toBe(1 + 64)
    expect(parsed.isVersioned).toBe(true)
    // Byte at messageStart is the 0x80 prefix.
    expect(tx[parsed.messageStart]).toBe(0x80)
  })
})

// ── Malformed inputs ──────────────────────────────────────────────────

describe('parseSolanaTx — malformed input (must throw)', () => {
  test('the reported bug: [0x80][sigCount][sigs][msg] is refused with a clear message', () => {
    const tx = malformedPrefixFirstTx()
    expect(() => parseSolanaTx(tx)).toThrow(SolanaTxParseError)
    try {
      parseSolanaTx(tx)
    } catch (err) {
      expect(err).toBeInstanceOf(SolanaTxParseError)
      expect((err as Error).message).toMatch(/first byte/i)
      expect((err as Error).message).toMatch(/versioned-message prefix/i)
    }
  })

  test('empty buffer throws', () => {
    expect(() => parseSolanaTx(Buffer.alloc(0))).toThrow(SolanaTxParseError)
  })

  test('zero sig count is refused (Solana transactions always have ≥1 signer)', () => {
    // [0x00][anything] — compact-u16 = 0 signatures, which real Solana txs never have.
    const tx = Buffer.concat([Buffer.from([0]), Buffer.alloc(10)])
    expect(() => parseSolanaTx(tx)).toThrow(SolanaTxParseError)
  })

  test('sig section larger than buffer is refused', () => {
    // Claim 5 sigs but buffer is too small.
    const tx = Buffer.concat([Buffer.from([5]), Buffer.alloc(64)]) // 65 bytes < 1+5*64
    expect(() => parseSolanaTx(tx)).toThrow(SolanaTxParseError)
  })

  test('reasonable upper-bound sigCount is accepted', () => {
    // Build a tx with MAX_SIGNATURES sigs.
    const sigs = Buffer.alloc(MAX_SIGNATURES * 64)
    const msg = Buffer.concat([Buffer.from([1, 0, 0]), Buffer.from([1]), Buffer.alloc(32), Buffer.alloc(32), Buffer.from([0])])
    const tx = Buffer.concat([Buffer.from([MAX_SIGNATURES]), sigs, msg])
    const parsed = parseSolanaTx(tx)
    expect(parsed.sigCount).toBe(MAX_SIGNATURES)
  })
})

// ── Regression: original stale-parser behavior would silently pass garbage ──

describe('parseSolanaTx — regression vs original inline parser', () => {
  test('the malformed layout is no longer silently forwarded with sigCount=128', () => {
    // The pre-fix inline parser computed sigCount = (0x80 & 0x7f) | (fullTx[1] << 7)
    // = 0 | (1 << 7) = 128 for malformedPrefixFirstTx(), then saw
    // messageStart=8194 > fullTx.length, fell into the `if (messageStart < length)`
    // guard being false, and shipped the full buffer to firmware. That silent
    // no-op is why OpenSea's "Malformed Solana transaction" error appeared
    // miles from the real parse failure. We now throw at the boundary.
    const tx = malformedPrefixFirstTx()
    expect(() => parseSolanaTx(tx)).toThrow(SolanaTxParseError)
  })
})
