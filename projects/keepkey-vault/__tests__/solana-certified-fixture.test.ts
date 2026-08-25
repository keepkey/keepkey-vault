/**
 * Pinned regression fixture: a real Relay Bridge depositNative v0 transaction
 * that genuinely references an Address Lookup Table. Captured 2026-05-25;
 * resolved accounts captured live from mainnet RPC 2026-08-24.
 *
 * This exists so the certified LUT path can be tested end-to-end without
 * depending on live RPC or on Relay's routing happening to return an
 * ALT-backed route on any given day — see
 * docs/RETRO-SOLANA-CERTIFIED-2026-08-24-NIGHT.md for why that dependency
 * burned a full night.
 */
import { describe, test, expect } from 'bun:test'
import bs58 from 'bs58'
import { parseSolanaTx, solanaMessageSlice, parseSolanaMessage } from '../src/bun/solana-tx'
import { resolveCanonicalLutAccounts } from '../src/bun/solana-lut-resolver'
import { CERTIFIED_SOLANA_CATALOG } from '../src/bun/solana-certified-schema'
import type { AltAccountFetcher } from '../src/bun/solana-alt'

import fixture from './fixtures/solana/relay-deposit-native-alt.json'
import noAltFixture from './fixtures/solana/relay-deposit-native-no-alt.json'

function fetcherFromFixture(): AltAccountFetcher {
  const resolved = fixture.resolvedAccountsBase64 as Record<string, string>
  const maxIndex = Math.max(...Object.keys(resolved).filter((k) => k !== '_comment').map(Number))
  const addresses = Buffer.alloc(0)
  const table = Buffer.concat([
    Buffer.alloc(56), // header, discriminator=0 is fine — resolver only reads addresses past offset 56
    ...Array.from({ length: maxIndex + 1 }, (_, i) =>
      resolved[String(i)] ? Buffer.from(resolved[String(i)], 'base64') : Buffer.alloc(32)),
  ])
  table.writeUInt32LE(1, 0) // LookupTable discriminator
  return async (keys: string[]) => keys.map((k) =>
    k === fixture.expected.altTable ? { data: table, owner: 'AddressLookupTab1e1111111111111111111111111' } : null)
}

describe('pinned fixture: real Relay depositNative v0 tx with an ALT reference', () => {
  test('parses to the expected structure', () => {
    const fullTx = Buffer.from(fixture.rawTxBase64, 'base64')
    const parsed = parseSolanaTx(fullTx)
    const messageBytes = solanaMessageSlice(fullTx, parsed)
    const message = parseSolanaMessage(messageBytes)

    expect(message.version).toBe(fixture.expected.version)
    expect(message.staticAccounts.map((a) => bs58.encode(a))).toEqual(fixture.expected.staticAccounts)
    expect(message.altEntries.length).toBe(1)
    expect(bs58.encode(message.altEntries[0].accountKey)).toBe(fixture.expected.altTable)
    expect(message.altEntries[0].writableIndices).toEqual(fixture.expected.writableIndices)
    expect(message.altEntries[0].readonlyIndices).toEqual(fixture.expected.readonlyIndices)

    const ix = message.instructions[0]
    expect(Buffer.from(ix.data).subarray(0, 8).toString('hex')).toBe(fixture.expected.instructionDiscriminatorHex)
    expect(ix.data.length).toBe(fixture.expected.instructionDataLen)
  })

  test('matches the reviewed relayDepositNative catalog entry', () => {
    const fullTx = Buffer.from(fixture.rawTxBase64, 'base64')
    const messageBytes = solanaMessageSlice(fullTx, parseSolanaTx(fullTx))
    const message = parseSolanaMessage(messageBytes)
    const ix = message.instructions[0]
    const programKey = bs58.encode(message.staticAccounts[ix.programIdIndex])
    const spec = CERTIFIED_SOLANA_CATALOG.relayDepositNative
    expect(programKey).toBe(spec.programId)
    expect(Buffer.from(ix.data).subarray(0, spec.discriminator.length)).toEqual(spec.discriminator)
  })

  test('resolveCanonicalLutAccounts reproduces the real, live-RPC-verified account order', async () => {
    const fullTx = Buffer.from(fixture.rawTxBase64, 'base64')
    const messageBytes = solanaMessageSlice(fullTx, parseSolanaTx(fullTx))
    const message = parseSolanaMessage(messageBytes)

    const result = await resolveCanonicalLutAccounts(message, fetcherFromFixture())
    const accountsBase64 = result.accounts.map((a) => a.toString('base64'))
    expect(accountsBase64).toEqual(fixture.expectedCanonicalOrderBase64)
    expect(result.writableCount).toBe(1)
    expect(result.readonlyCount).toBe(2)
  })
})

describe('pinned fixture: real Relay depositNative v0 tx with static accounts only', () => {
  test('parses to the exact live no-LUT structure', () => {
    const fullTx = Buffer.from(noAltFixture.rawTxBase64, 'base64')
    const parsed = parseSolanaTx(fullTx)
    const messageBytes = solanaMessageSlice(fullTx, parsed)
    const message = parseSolanaMessage(messageBytes)

    expect(fullTx.length).toBe(noAltFixture.expected.wireBytes)
    expect(message.version).toBe(noAltFixture.expected.version)
    expect(message.staticAccounts.map((a) => bs58.encode(a))).toEqual(noAltFixture.expected.staticAccounts)
    expect(message.altEntries).toEqual([])
    expect(message.altEntries.length).toBe(noAltFixture.expected.altEntries)

    expect(message.instructions).toHaveLength(1)
    const ix = message.instructions[0]
    expect(bs58.encode(message.staticAccounts[ix.programIdIndex])).toBe(noAltFixture.expected.programId)
    expect(ix.accountIndices).toEqual(noAltFixture.expected.instructionAccountIndices)
    expect(Buffer.from(ix.data).subarray(0, 8).toString('hex')).toBe(noAltFixture.expected.instructionDiscriminatorHex)
    expect(ix.data.length).toBe(noAltFixture.expected.instructionDataLen)
    expect(Buffer.from(ix.data).readBigUInt64LE(8).toString()).toBe(noAltFixture.expected.amountLamports)
    expect(bs58.encode(message.staticAccounts[ix.accountIndices[3]])).toBe(noAltFixture.expected.vault)
  })

  test('matches the same reviewed schema as the ALT-backed route', () => {
    const fullTx = Buffer.from(noAltFixture.rawTxBase64, 'base64')
    const message = parseSolanaMessage(solanaMessageSlice(fullTx, parseSolanaTx(fullTx)))
    const ix = message.instructions[0]
    const spec = CERTIFIED_SOLANA_CATALOG.relayDepositNative

    expect(bs58.encode(message.staticAccounts[ix.programIdIndex])).toBe(spec.programId)
    expect(Buffer.from(ix.data).subarray(0, spec.discriminator.length)).toEqual(spec.discriminator)
  })

  test('does not manufacture a LUT requirement for a self-contained message', async () => {
    const fullTx = Buffer.from(noAltFixture.rawTxBase64, 'base64')
    const message = parseSolanaMessage(solanaMessageSlice(fullTx, parseSolanaTx(fullTx)))

    expect(message.altEntries).toHaveLength(0)
    await expect(resolveCanonicalLutAccounts(message, async () => {
      throw new Error('no RPC lookup should occur for a self-contained message')
    })).rejects.toThrow(/no address table lookups/i)
  })
})
