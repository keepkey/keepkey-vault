import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import bs58 from 'bs58'

import { certifiedSolanaProofApplies, routeExternalSolanaTransaction, type CertifiedSolanaProof } from '../src/bun/solana-certified-registry'
import { CERTIFIED_SOLANA_CATALOG, serializeSolanaSchema } from '../src/bun/solana-certified-schema'
import { buildSolanaDecodedInfo } from '../src/bun/solana-clearsign'
import { editSolanaTx } from '../scripts/fixtures/solana-message'
import { syntheticPumpBuy } from '../scripts/fixtures/solana-pump'
import joinFixture from './fixtures/solana/soltoshidice-blackjack-join.json'
import relayAltFixture from './fixtures/solana/relay-deposit-native-alt.json'
import relayFixture from './fixtures/solana/relay-deposit-native-no-alt.json'

const originalFetch = globalThis.fetch
const originalServiceUrl = process.env.CLEARSIGN_SERVICE_URL

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalServiceUrl === undefined) delete process.env.CLEARSIGN_SERVICE_URL
  else process.env.CLEARSIGN_SERVICE_URL = originalServiceUrl
})

describe('routeExternalSolanaTransaction (REST pre-approval auto-lookup)', () => {
  // Real SoltoshiDICE "Blackjack join" from a dapp: unknown program, so the
  // host (and firmware) would otherwise treat it as opaque.
  const joinRawTx = joinFixture.rawTxBase64
  const joinPayload = serializeSolanaSchema(CERTIFIED_SOLANA_CATALOG.soltoshidiceBlackjackJoin).toString('hex')
  const noAlts = async (): Promise<never> => { throw new Error('transaction has no lookup tables') }
  const decoded = (rawTx: string) => buildSolanaDecodedInfo(rawTx, noAlts)

  function certifiedJoinResponse(edit: (body: any) => void = () => {}): Response {
    const body = {
      catalogKey: 'soltoshidiceBlackjackJoin',
      classification: 'VERIFIED',
      schema: { payload: `0x${joinPayload}`, signature: `0x${'22'.repeat(64)}`, signerKeyId: 0x80 },
      certificate: `0x${'33'.repeat(139)}`,
      tokenInfo: [{ mint: '4nCmpwne7hCoWTSpAd54uENmCgHJrHTyn4DMPCEMpump', symbol: 'SDICE', decimals: 6, signature: '55'.repeat(64), signerKeyId: 0x80 }],
    }
    edit(body)
    return new Response(JSON.stringify(body), { status: 200 })
  }

  /** Count service calls; every call would get a complete certified envelope. */
  function countingService() {
    const calls: any[] = []
    globalThis.fetch = (async (_input: any, init: any) => {
      calls.push(JSON.parse(init.body))
      return certifiedJoinResponse()
    }) as unknown as typeof fetch
    return calls
  }

  test('the real join routes certified: no one-shot consent, no AdvancedMode', async () => {
    process.env.CLEARSIGN_SERVICE_URL = 'http://127.0.0.1:1647'
    const calls = countingService()
    const route = await routeExternalSolanaTransaction(await decoded(joinRawTx), { raw_tx: joinRawTx }, '7.16.0')
    // Sent only after the local catalog match, with that entry's key.
    expect(calls).toEqual([{ rawTx: joinRawTx, catalogKey: 'soltoshidiceBlackjackJoin' }])
    expect(route.requiresBlindSigningConsent).toBe(false)
    expect(route.certifiedProof?.schema.payload).toBe(joinPayload)
    expect(route.certifiedProof?.certificate).toHaveLength(278)
    expect(route.certifiedProof?.tokenInfo?.[0].symbol).toBe('SDICE')
  })

  test('transactions the device would refuse on the certified path stay opaque and never leave the machine', async () => {
    process.env.CLEARSIGN_SERVICE_URL = 'http://127.0.0.1:1647'
    const calls = countingService()
    const joinWithAtaCreate = editSolanaTx(joinRawTx, (m) => {
      m.staticAccounts.push(Buffer.from(bs58.decode('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')))
      m.header[2]++
      m.instructions.splice(2, 0, { programIdIndex: m.staticAccounts.length - 1, accountIndices: [0, 6, 0, 8, 7, 12], data: Buffer.from([1]) })
    })
    // 9 instructions, with ATA create, SyncNative, and closeAccount beside the buy.
    const pumpBuy = syntheticPumpBuy().rawTx
    for (const rawTx of [joinWithAtaCreate, pumpBuy]) {
      expect(await routeExternalSolanaTransaction(await decoded(rawTx), { raw_tx: rawTx }, '7.16.0'))
        .toEqual({ requiresBlindSigningConsent: true })
    }
    expect(calls).toHaveLength(0)
  })

  test('an unrelated dapp transaction is never sent to the service', async () => {
    process.env.CLEARSIGN_SERVICE_URL = 'http://127.0.0.1:1647'
    const calls = countingService()
    // The join's bytes with another program, and another instruction tag.
    const otherProgram = editSolanaTx(joinRawTx, (m) => { m.staticAccounts[11] = Buffer.alloc(32, 0x77) })
    const otherInstruction = editSolanaTx(joinRawTx, (m) => { m.instructions[2].data[0] = 0x52 })
    for (const rawTx of [otherProgram, otherInstruction]) {
      const decodedOther = await decoded(rawTx)
      expect(decodedOther.hasUnknownProgram).toBe(true)
      expect(await routeExternalSolanaTransaction(decodedOther, { raw_tx: rawTx }, '7.16.0'))
        .toEqual({ requiresBlindSigningConsent: true })
    }
    expect(calls).toHaveLength(0)
  })

  test('no match, an unavailable service, or an envelope the device would not apply keep the opaque path', async () => {
    process.env.CLEARSIGN_SERVICE_URL = 'http://127.0.0.1:1647'
    const cases: Array<() => Promise<Response>> = [
      async () => new Response(JSON.stringify({ classification: 'OPAQUE', error: 'no match' }), { status: 422 }),
      async () => new Response(JSON.stringify({ classification: 'UNAVAILABLE' }), { status: 503 }),
      async () => { throw new Error('connect ECONNREFUSED') },
      async () => new Response('not json', { status: 200 }),
      async () => certifiedJoinResponse((body) => { body.schema.signerKeyId = 1 }),
      // Not the reviewed schema the local rule was checked against.
      async () => certifiedJoinResponse((body) => {
        body.schema.payload = serializeSolanaSchema(CERTIFIED_SOLANA_CATALOG.relayDepositNative).toString('hex')
      }),
      // A LUT proof for a message without lookup tables.
      async () => certifiedJoinResponse((body) => {
        body.lutProof = { accounts: [Buffer.alloc(32, 0x11).toString('base64')], signature: '44'.repeat(64), signerKeyId: 0x80 }
      }),
    ]
    for (const respond of cases) {
      globalThis.fetch = respond as unknown as typeof fetch
      const route = await routeExternalSolanaTransaction(await decoded(joinRawTx), { raw_tx: joinRawTx }, '7.16.0')
      expect(route).toEqual({ requiresBlindSigningConsent: true })
    }

    // The join with one lookup-table index. The device needs exactly one
    // proof key per serialized LUT index: no proof, or a surplus key, is a
    // hard certified failure (solana_certifiedLutShapeMatches, and the
    // trusted vs serialized LUT count check in solana_parseVersionedTx).
    const joinWithLut = editSolanaTx(joinRawTx, (m) => {
      m.version = 'v0'
      m.altEntries = [{ accountKey: Buffer.alloc(32, 0x42), writableIndices: [3], readonlyIndices: [] }]
    })
    const lutProof = (keys: number) => ({
      accounts: Array.from({ length: keys }, (_, i) => Buffer.alloc(32, 0x60 + i).toString('base64')),
      signature: '44'.repeat(64),
      signerKeyId: 0x80,
    })
    const lutCases: Array<[string, () => Promise<Response>]> = [
      // A message with lookup tables but an envelope without a LUT proof.
      ['missing lutProof', async () => certifiedJoinResponse()],
      // One key more than the message's LUT indices.
      ['2 keys for 1 index', async () => certifiedJoinResponse((body) => { body.lutProof = lutProof(2) })],
    ]
    for (const [, respond] of lutCases) {
      globalThis.fetch = respond as unknown as typeof fetch
      const route = await routeExternalSolanaTransaction(await decoded(joinWithLut), { raw_tx: joinWithLut }, '7.16.0')
      expect(route).toEqual({ requiresBlindSigningConsent: true })
    }
    // Control: the exact proof routes certified.
    globalThis.fetch = (async () => certifiedJoinResponse((body) => { body.lutProof = lutProof(1) })) as unknown as typeof fetch
    const exact = await routeExternalSolanaTransaction(await decoded(joinWithLut), { raw_tx: joinWithLut }, '7.16.0')
    expect(exact.requiresBlindSigningConsent).toBe(false)
    expect(exact.certifiedProof?.lutProof?.accounts).toHaveLength(1)
  })

  test('never contacts the service for older firmware, caller metadata, or native clear-signs', async () => {
    const calls = countingService()
    expect(await routeExternalSolanaTransaction(await decoded(joinRawTx), { raw_tx: joinRawTx }, '7.15.9'))
      .toEqual({ requiresBlindSigningConsent: true })
    expect(await routeExternalSolanaTransaction(await decoded(joinRawTx), { raw_tx: joinRawTx }, undefined))
      .toEqual({ requiresBlindSigningConsent: true })
    // Caller-supplied material is forwarded to firmware unchanged instead.
    expect(await routeExternalSolanaTransaction(await decoded(joinRawTx), {
      raw_tx: joinRawTx, schema: { payload: 'aa', signature: 'bb', signerKeyId: 1 },
    }, '7.16.0')).toEqual({ requiresBlindSigningConsent: false })
    expect(await routeExternalSolanaTransaction(await decoded(joinRawTx), {
      raw_tx: joinRawTx, certificate: '33'.repeat(139),
    }, '7.16.0')).toEqual({ requiresBlindSigningConsent: true })
    // A native System transfer never leaves the machine.
    const joinDecoded = await decoded(joinRawTx)
    const nativeOnly = { ...joinDecoded, instructions: joinDecoded.instructions.slice(0, 2) }
    expect(await routeExternalSolanaTransaction(nativeOnly, { raw_tx: joinRawTx }, '7.16.0'))
      .toEqual({ requiresBlindSigningConsent: false })
    expect(calls).toHaveLength(0)
  })
})

describe('swap.ts: a Relay certified proof is attached only when the device will apply it', () => {
  const relayPayload = serializeSolanaSchema(CERTIFIED_SOLANA_CATALOG.relayDepositNative).toString('hex')
  const proof = (lutKeys?: number, payload = relayPayload): CertifiedSolanaProof => ({
    ...(lutKeys === undefined ? {} : {
      lutProof: {
        accounts: Array.from({ length: lutKeys }, (_, i) => Buffer.alloc(32, 0x60 + i).toString('base64')),
        signature: '44'.repeat(64),
        signerKeyId: 0x80,
      },
    }),
    schema: { payload, signature: '22'.repeat(64), signerKeyId: 0x80 },
    certificate: '33'.repeat(139),
  })

  test('real Relay deposits apply with the exact envelope', () => {
    expect(certifiedSolanaProofApplies(relayFixture.rawTxBase64, 'relayDepositNative', proof())).toBe(true)
    // Three LUT indices (writable [2], readonly [1, 14]): three proof keys.
    expect(certifiedSolanaProofApplies(relayAltFixture.rawTxBase64, 'relayDepositNative', proof(3))).toBe(true)
  })

  test('an envelope the device would refuse falls back to the consent path', () => {
    // A companion the certified review does not allow (an unknown program).
    const withUnknownCompanion = editSolanaTx(relayFixture.rawTxBase64, (m) => {
      m.staticAccounts.push(Buffer.alloc(32, 0x77))
      m.header[2]++
      m.instructions.push({ programIdIndex: m.staticAccounts.length - 1, accountIndices: [], data: Buffer.from([1]) })
    })
    expect(certifiedSolanaProofApplies(withUnknownCompanion, 'relayDepositNative', proof())).toBe(false)
    // LUT proof shape: missing, short, surplus, or on a self-contained message.
    for (const lutKeys of [undefined, 2, 4]) {
      expect(certifiedSolanaProofApplies(relayAltFixture.rawTxBase64, 'relayDepositNative', proof(lutKeys))).toBe(false)
    }
    expect(certifiedSolanaProofApplies(relayFixture.rawTxBase64, 'relayDepositNative', proof(1))).toBe(false)
    // Not the reviewed schema for the requested catalog entry, or not a catalog entry.
    const tokenPayload = serializeSolanaSchema(CERTIFIED_SOLANA_CATALOG.relayDepositToken).toString('hex')
    expect(certifiedSolanaProofApplies(relayFixture.rawTxBase64, 'relayDepositNative', proof(undefined, tokenPayload))).toBe(false)
    expect(certifiedSolanaProofApplies(relayFixture.rawTxBase64, 'relayDepositToken', proof(undefined, tokenPayload))).toBe(false)
    expect(certifiedSolanaProofApplies(relayFixture.rawTxBase64, 'noSuchEntry', proof())).toBe(false)
    expect(certifiedSolanaProofApplies('not a transaction', 'relayDepositNative', proof())).toBe(false)
  })

  test('swap.ts drops a fetched proof the device would not apply before attaching it', () => {
    const swap = readFileSync(new URL('../src/bun/swap.ts', import.meta.url), 'utf8')
    const fetched = swap.indexOf('certifiedProof = await findCertifiedSolanaProof(params.relayTx.serializedTx, catalogKey)')
    const guard = swap.indexOf('if (certifiedProof && !certifiedSolanaProofApplies(params.relayTx.serializedTx, catalogKey, certifiedProof)) {')
    const attached = swap.indexOf('schema: certifiedProof.schema, certificate: certifiedProof.certificate')
    expect(fetched).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(fetched)
    expect(swap.slice(guard, guard + 400)).toContain('certifiedProof = undefined')
    expect(attached).toBeGreaterThan(guard)
  })
})
