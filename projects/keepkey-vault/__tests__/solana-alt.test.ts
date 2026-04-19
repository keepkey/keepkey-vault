/**
 * Tests for the Address Lookup Table resolver.
 *
 * All tests use an injected fetcher — no network I/O. Covers the ALT account
 * parser (56-byte header + 32-byte address stride) plus the resolver's
 * graceful handling of missing / malformed accounts.
 *
 * Run: bun test __tests__/solana-alt.test.ts
 */
import { describe, test, expect } from 'bun:test'
import bs58 from 'bs58'
import { parseAltAccountData, resolveAlts, SolanaAltResolveError, ALT_HEADER_LEN } from '../src/bun/solana-alt'

function makeAltAccount(addresses: Uint8Array[]): Uint8Array {
  const header = Buffer.alloc(ALT_HEADER_LEN)
  // Leave zeroed — resolver doesn't validate header fields.
  return Buffer.concat([header, ...addresses])
}

describe('parseAltAccountData', () => {
  test('decodes a 2-address ALT to base58', () => {
    const a1 = Buffer.alloc(32, 0x11)
    const a2 = Buffer.alloc(32, 0x22)
    const acct = makeAltAccount([a1, a2])
    const addrs = parseAltAccountData(acct)
    expect(addrs).toHaveLength(2)
    expect(addrs[0]).toBe(bs58.encode(a1))
    expect(addrs[1]).toBe(bs58.encode(a2))
  })

  test('empty ALT (header only) yields no addresses', () => {
    expect(parseAltAccountData(Buffer.alloc(ALT_HEADER_LEN))).toEqual([])
  })

  test('rejects account shorter than header', () => {
    expect(() => parseAltAccountData(Buffer.alloc(32))).toThrow(SolanaAltResolveError)
  })

  test('rejects body length not a multiple of 32', () => {
    expect(() => parseAltAccountData(Buffer.alloc(ALT_HEADER_LEN + 10))).toThrow(SolanaAltResolveError)
  })
})

describe('resolveAlts', () => {
  test('maps each pubkey to its address list via injected fetcher', async () => {
    const pk1 = bs58.encode(Buffer.alloc(32, 0xaa))
    const pk2 = bs58.encode(Buffer.alloc(32, 0xbb))
    const alt1Addrs = [Buffer.alloc(32, 0x01), Buffer.alloc(32, 0x02)]
    const alt2Addrs = [Buffer.alloc(32, 0x03)]
    const out = await resolveAlts([pk1, pk2], async (keys) => {
      expect(keys).toEqual([pk1, pk2])
      return [makeAltAccount(alt1Addrs), makeAltAccount(alt2Addrs)]
    })
    expect(out.get(pk1)).toHaveLength(2)
    expect(out.get(pk2)).toHaveLength(1)
    expect(out.get(pk1)![0]).toBe(bs58.encode(alt1Addrs[0]))
  })

  test('skips missing (null) accounts silently', async () => {
    const pk1 = bs58.encode(Buffer.alloc(32, 0xcc))
    const pk2 = bs58.encode(Buffer.alloc(32, 0xdd))
    const out = await resolveAlts([pk1, pk2], async () => [makeAltAccount([Buffer.alloc(32, 1)]), null])
    expect(out.has(pk1)).toBe(true)
    expect(out.has(pk2)).toBe(false)
  })

  test('skips malformed account data without throwing', async () => {
    const pk = bs58.encode(Buffer.alloc(32, 0xee))
    const out = await resolveAlts([pk], async () => [Buffer.alloc(20)]) // too small
    expect(out.has(pk)).toBe(false)
  })

  test('empty input is a no-op', async () => {
    const out = await resolveAlts([], async () => { throw new Error('should not fetch') })
    expect(out.size).toBe(0)
  })

  test('throws when fetcher returns a mismatched length', async () => {
    const pk = bs58.encode(Buffer.alloc(32, 0xff))
    await expect(resolveAlts([pk], async () => [])).rejects.toThrow(SolanaAltResolveError)
  })
})
