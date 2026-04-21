/**
 * Tests for the Address Lookup Table resolver.
 *
 * All tests use an injected fetcher — no network I/O. Covers the ALT account
 * parser (discriminator + 56-byte header + 32-byte address stride) plus the
 * resolver's ownership check and graceful handling of missing / malformed
 * accounts.
 *
 * Run: bun test __tests__/solana-alt.test.ts
 */
import { describe, test, expect } from 'bun:test'
import bs58 from 'bs58'
import {
  parseAltAccountData,
  resolveAlts,
  SolanaAltResolveError,
  ALT_HEADER_LEN,
  ALT_PROGRAM_ID,
  ALT_DISCRIMINATOR_LOOKUP_TABLE,
  type AltAccountData,
} from '../src/bun/solana-alt'

/**
 * Build a well-formed ALT account header (56 bytes) with the
 * `LookupTable` discriminator, no authority, followed by the given
 * addresses. Mirrors Solana's bincode layout in
 * `solana-sdk/address-lookup-table/program/src/state.rs`.
 */
function makeAltAccount(addresses: Uint8Array[]): Uint8Array {
  const header = Buffer.alloc(ALT_HEADER_LEN)
  // Discriminator = 1 (LookupTable) as u32 LE.
  header.writeUInt32LE(ALT_DISCRIMINATOR_LOOKUP_TABLE, 0)
  // authority_option = 0 (None) at byte 21. Rest stays zeroed.
  header[21] = 0
  return Buffer.concat([header, ...addresses])
}

function altOwned(bytes: Uint8Array): AltAccountData {
  return { data: bytes, owner: ALT_PROGRAM_ID }
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
    expect(parseAltAccountData(makeAltAccount([]))).toEqual([])
  })

  test('rejects account shorter than header', () => {
    expect(() => parseAltAccountData(Buffer.alloc(32))).toThrow(SolanaAltResolveError)
  })

  test('rejects body length not a multiple of 32', () => {
    const acct = Buffer.concat([makeAltAccount([]), Buffer.alloc(10)])
    expect(() => parseAltAccountData(acct)).toThrow(SolanaAltResolveError)
  })

  test('rejects Uninitialized discriminator (0) — prevents non-ALT spoofing', () => {
    // 56-byte header with discriminator=0, followed by two 32-byte pubkeys.
    // Without discriminator validation this would decode cleanly — the
    // attacker wins. With validation it throws.
    const header = Buffer.alloc(ALT_HEADER_LEN) // all zeros → discriminator=0
    const payload = Buffer.concat([header, Buffer.alloc(32, 0x01), Buffer.alloc(32, 0x02)])
    expect(() => parseAltAccountData(payload)).toThrow(/discriminator/)
  })

  test('rejects garbage discriminator (2+) — prevents non-ALT spoofing', () => {
    const header = Buffer.alloc(ALT_HEADER_LEN)
    header.writeUInt32LE(7, 0) // bogus discriminator
    const payload = Buffer.concat([header, Buffer.alloc(32, 0x42)])
    expect(() => parseAltAccountData(payload)).toThrow(/discriminator/)
  })

  test('rejects invalid authority_option byte (must be 0 or 1)', () => {
    const header = Buffer.alloc(ALT_HEADER_LEN)
    header.writeUInt32LE(ALT_DISCRIMINATOR_LOOKUP_TABLE, 0)
    header[21] = 0xff // not a valid bincode Option tag
    const payload = Buffer.concat([header, Buffer.alloc(32, 0x33)])
    expect(() => parseAltAccountData(payload)).toThrow(/authority_option/)
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
      return [altOwned(makeAltAccount(alt1Addrs)), altOwned(makeAltAccount(alt2Addrs))]
    })
    expect(out.get(pk1)).toHaveLength(2)
    expect(out.get(pk2)).toHaveLength(1)
    expect(out.get(pk1)![0]).toBe(bs58.encode(alt1Addrs[0]))
  })

  test('skips missing (null) accounts silently', async () => {
    const pk1 = bs58.encode(Buffer.alloc(32, 0xcc))
    const pk2 = bs58.encode(Buffer.alloc(32, 0xdd))
    const out = await resolveAlts([pk1, pk2], async () => [
      altOwned(makeAltAccount([Buffer.alloc(32, 1)])),
      null,
    ])
    expect(out.has(pk1)).toBe(true)
    expect(out.has(pk2)).toBe(false)
  })

  test('skips malformed account data without throwing', async () => {
    const pk = bs58.encode(Buffer.alloc(32, 0xee))
    const out = await resolveAlts([pk], async () => [altOwned(Buffer.alloc(20))]) // too small
    expect(out.has(pk)).toBe(false)
  })

  test('skips accounts not owned by the ALT program (prevents spoofing)', async () => {
    // Build an account whose *data* looks like a valid ALT but whose owner
    // is a random program. A malicious v0 tx that references this account
    // must not have its bytes surfaced as "resolved accounts".
    const pk = bs58.encode(Buffer.alloc(32, 0x99))
    const bytes = makeAltAccount([Buffer.alloc(32, 0xfe)])
    const hostileOwner = bs58.encode(Buffer.alloc(32, 0x77))
    const out = await resolveAlts([pk], async () => [{ data: bytes, owner: hostileOwner }])
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
