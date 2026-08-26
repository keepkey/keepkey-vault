import { describe, test, expect } from 'bun:test'
import bs58 from 'bs58'

import { resolveCanonicalLutAccounts, SolanaLutCanonicalizationError } from './solana-lut-resolver'
import { SolanaAltResolveError } from './solana-alt'
import type { ParsedSolanaMessage, SolanaAltEntry } from './solana-tx'
import type { AltAccountFetcher } from './solana-alt'

function pubkey(seed: number): Buffer {
  return Buffer.alloc(32, seed)
}

function b58(buf: Buffer): string {
  return bs58.encode(buf)
}

function fakeMessage(altEntries: SolanaAltEntry[]): ParsedSolanaMessage {
  return {
    version: 'v0',
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
    staticAccounts: [],
    recentBlockhash: pubkey(0xff),
    instructions: [],
    altEntries,
  }
}

/** Table with `count` sequentially-seeded 32-byte addresses. */
function fakeTable(tableSeed: number, count: number): { key: Buffer; addresses: Buffer[] } {
  const key = pubkey(tableSeed)
  const addresses = Array.from({ length: count }, (_, i) => pubkey(tableSeed * 100 + i))
  return { key, addresses }
}

function fetcherFor(tables: Array<{ key: Buffer; addresses: Buffer[] }>): AltAccountFetcher {
  return async (altPubkeysBase58: string[]) => {
    return altPubkeysBase58.map((k) => {
      const table = tables.find((t) => b58(t.key) === k)
      if (!table) return null
      // ALT account bytes: 56-byte header + 32*N addresses.
      const header = Buffer.alloc(56)
      header.writeUInt32LE(1, 0) // discriminator = LookupTable
      const data = Buffer.concat([header, ...table.addresses])
      return { data, owner: 'AddressLookupTab1e1111111111111111111111111' }
    })
  }
}

describe('resolveCanonicalLutAccounts', () => {
  test('orders writable-then-readonly across multiple tables, preserving table and index order', async () => {
    const tableA = fakeTable(1, 4)
    const tableB = fakeTable(2, 4)
    const message = fakeMessage([
      { accountKey: tableA.key, writableIndices: [1, 0], readonlyIndices: [2] },
      { accountKey: tableB.key, writableIndices: [3], readonlyIndices: [0, 1] },
    ])
    const result = await resolveCanonicalLutAccounts(message, fetcherFor([tableA, tableB]))
    expect(result.writableCount).toBe(3)
    expect(result.readonlyCount).toBe(3)
    expect(result.accounts.length).toBe(6)
    // writable: A[1], A[0], B[3] ; readonly: A[2], B[0], B[1]
    expect(result.accounts[0]).toEqual(tableA.addresses[1])
    expect(result.accounts[1]).toEqual(tableA.addresses[0])
    expect(result.accounts[2]).toEqual(tableB.addresses[3])
    expect(result.accounts[3]).toEqual(tableA.addresses[2])
    expect(result.accounts[4]).toEqual(tableB.addresses[0])
    expect(result.accounts[5]).toEqual(tableB.addresses[1])
  })

  test('rejects a missing/inactive table', async () => {
    const tableA = fakeTable(1, 2)
    const message = fakeMessage([{ accountKey: pubkey(99), writableIndices: [0], readonlyIndices: [] }])
    await expect(resolveCanonicalLutAccounts(message, fetcherFor([tableA]))).rejects.toThrow(SolanaAltResolveError)
  })

  test('rejects an out-of-range index', async () => {
    const tableA = fakeTable(1, 2)
    const message = fakeMessage([{ accountKey: tableA.key, writableIndices: [5], readonlyIndices: [] }])
    await expect(resolveCanonicalLutAccounts(message, fetcherFor([tableA]))).rejects.toThrow(/out of range/)
  })

  test('rejects a duplicate resolved account (ambiguous)', async () => {
    const tableA = fakeTable(1, 2)
    const message = fakeMessage([{ accountKey: tableA.key, writableIndices: [0], readonlyIndices: [0] }])
    await expect(resolveCanonicalLutAccounts(message, fetcherFor([tableA]))).rejects.toThrow(SolanaLutCanonicalizationError)
  })

  test('rejects more than 8 total resolved accounts', async () => {
    const tableA = fakeTable(1, 10)
    const message = fakeMessage([
      { accountKey: tableA.key, writableIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8], readonlyIndices: [] },
    ])
    await expect(resolveCanonicalLutAccounts(message, fetcherFor([tableA]))).rejects.toThrow(/exceeding firmware/)
  })

  test('rejects a message with no address table lookups', async () => {
    const message = fakeMessage([])
    await expect(resolveCanonicalLutAccounts(message, fetcherFor([]))).rejects.toThrow(SolanaLutCanonicalizationError)
  })
})
