/**
 * The production ClearSign catalog, batch 1: descriptions signed OFFLINE in
 * the 2026-10-16 ceremony (root 027c1fde...e321). The production Worker
 * serves only these bytes, and Desktop throws a served description away
 * unless its own definition serializes to exactly them
 * (certifiedSolanaProofApplies; the method and body checks in
 * evm-schema-registry). So every signed entry must equal Desktop's local
 * serialization of its catalog key.
 *
 * The fixtures are verbatim copies of keepkey-clearsign-server-static
 * worker/shared/production-catalog-batch1.json and -batch2.json (the
 * ceremony's signed-catalog-batch1.json and -batch2.json). Batch 2 replaced
 * batch 1's Arbitrum USDT approval with a Permit2-pinned and a generic entry;
 * the Worker no longer serves the batch-1 one.
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, test } from 'bun:test'
import bs58 from 'bs58'

import signed from './fixtures/clearsign-production-catalog-batch1.json'
import batch2 from './fixtures/clearsign-production-catalog-batch2.json'
import { CERTIFIED_SOLANA_CATALOG, serializeSolanaSchema } from '../src/bun/solana-certified-schema'
import { buildEvmSchemaBody, findCertifiedEvmSchemaSpec } from '../src/bun/evm-certified-schema'
import { certifiedSolanaProofApplies, prepareExternalSolanaProof, type CertifiedSolanaProof } from '../src/bun/solana-certified-registry'
import { findCertifiedEvmSchema } from '../src/bun/evm-schema-registry'

type Entry = (typeof signed.entries)[number]

const ARB_USDT = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'
const RELAY_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')
const approve = (spender: string) => `0x095ea7b3${word(spender)}${'ff'.repeat(32)}`
const bridgeDeposit = `0x49290c1c${word('909ef6b32dfdc12ca86aa710b54c991af3c5f82e')}${'8a'.repeat(32)}`

// Each signed entry (by digest) and the Desktop catalog key that must reproduce it.
const SOLANA_KEYS: Record<string, string> = {
  '41b03332071d581a5002d02f02107256f97e7bf36a8cf2c8b0e6516b68ce3bee': 'pumpAmmBuy',
  '846edad3af4b5fd231fe7b447fecba9bc0a35af1c4673741b27b22e424feeec5': 'soltoshidiceBlackjackJoin',
  '70bdde767b328c0006a7a5aaf0e6d01f3334a306ef77c748a712e186b993655d': 'soltoshidiceRegisterPokerTournament',
  'a164906df42a5471430ba210b60945788ad3c8cc720716332bcf506081f3b6cf': 'soltoshidiceEnterPokerTournament',
  '3e7970c8dc00ab113206c03757a0c0b67eac226f2998b0a53bce614f98051935': 'soltoshidiceAuthorizePokerSession',
  '9540805305ddf77463e98a1859ee3b08e69725f2393476c10643e6b7468636bd': 'soltoshidiceSetPokerReady',
  'e1ea566bfbecb01d858917d514cda2518f9ea0f38bae694bad761a606ac10dba': 'soltoshidiceCeeloBet',
  '43aa746f600e13022d721550b16bfc62675d07e3f70179b9c2d133f67b40c047': 'relayDepositNative',
  'd99925f9c8359db22cee3c5772f05acbe0427985f1801e7e512bb6eabc647c3a': 'relayDepositToken',
}
// EVM entries are looked up from calldata (findCertifiedEvmSchemaSpec), so
// each one lists the calls that must resolve to the signed body.
const EVM_CALLS: Record<string, { key: string; chainId: number; to: string; calldata: string[] }> = {
  'e2769638c2f849d6dc44bf62713a808057ead3a48e8a24ea1628adb2a6e22767': {
    key: `1:${RELAY_DEPOSITORY}:0x49290c1c`, chainId: 1, to: RELAY_DEPOSITORY, calldata: [bridgeDeposit],
  },
  // Batch 2: the Arbitrum USDT0 approve, one entry with Permit2 pinned as the
  // spender and one for any other spender.
  'ad0c184ae8765a08cbb2c92cf69d6d1b46ed4c3b4da565e5d1c5dbb1864b0fd5': {
    key: `42161:${ARB_USDT}:0x095ea7b3:permit2`, chainId: 42161, to: ARB_USDT,
    calldata: [approve('0x000000000022d473030f116ddee9f6b43ac78ba3')],
  },
  '49fdb51938cdec05cbb416a070da59b12fd7468fe29bc4fa52c88714b37c7e94': {
    key: `42161:${ARB_USDT}:0x095ea7b3`, chainId: 42161, to: ARB_USDT,
    calldata: [approve('0x909ef6b32dfdc12ca86aa710b54c991af3c5f82e')],
  },
}
// Batch 1's Arbitrum USDT approval ("Arbitrum USDT approval", any spender),
// superseded by the two batch-2 entries above.
const SUPERSEDED = new Set(['2f17530521daab81a1bd0b2feaa770fca5a5f785a12605caf965df0d5b4f2563'])

const entryByDigest = (digest: string): Entry =>
  (signed.entries.find((entry) => entry.digest_hex === digest) ?? batch2.entries.find((entry) => entry.digest_hex === digest)) as Entry
/** The method name inside a signed 0x02 body (after version, chain, contract, selector). */
const signedMethod = (entryHex: string) => {
  const body = Buffer.from(entryHex, 'hex')
  return body.subarray(31, 31 + body.readUInt16BE(29)).toString('ascii')
}

describe('production catalog batch 1: Desktop serializes every signed entry byte-for-byte', () => {
  test('every signed entry is mapped to exactly one Desktop key, and its digest is sha256 of its body', () => {
    const batch1Mapped = [...Object.keys(SOLANA_KEYS), ...Object.keys(EVM_CALLS)]
      .filter((digest) => signed.entries.some((entry) => entry.digest_hex === digest))
    expect([...batch1Mapped, ...SUPERSEDED].sort()).toEqual(signed.entries.map((entry) => entry.digest_hex).sort())
    for (const entry of signed.entries) {
      expect(createHash('sha256').update(Buffer.from(entry.entry_hex, 'hex')).digest('hex')).toBe(entry.digest_hex)
    }
  })

  for (const [digest, key] of Object.entries(SOLANA_KEYS)) {
    test(`Solana ${key}`, () => {
      const entry = entryByDigest(digest)
      expect([entry.kind, entry.scope]).toEqual([3, 501])
      expect(serializeSolanaSchema(CERTIFIED_SOLANA_CATALOG[key]).toString('hex')).toBe(entry.entry_hex)
    })
  }

  for (const [digest, { key, chainId, to, calldata }] of Object.entries(EVM_CALLS)) {
    test(`EVM ${key}`, () => {
      const entry = entryByDigest(digest)
      expect([entry.kind, entry.scope]).toEqual([1, chainId])
      // What Desktop compares a served envelope against: 0x03 | cert(139) | body | sig(65).
      const envelope = Buffer.from(entry.certified_payload_hex!, 'hex')
      expect(envelope.subarray(140, -65).toString('hex')).toBe(entry.entry_hex)
      expect(envelope.readUInt32BE(3)).toBe(chainId)
      for (const data of calldata) {
        const spec = findCertifiedEvmSchemaSpec(chainId, to, data)!
        expect(buildEvmSchemaBody(spec).toString('hex')).toBe(entry.entry_hex)
        expect(spec.method).toBe(signedMethod(entry.entry_hex))
      }
    })
  }
})

test('the superseded batch-1 USDT approval is no longer what Desktop builds', () => {
  const old = signed.entries.find((entry) => SUPERSEDED.has(entry.digest_hex))!
  for (const spender of ['0x000000000022d473030f116ddee9f6b43ac78ba3', '0x909ef6b32dfdc12ca86aa710b54c991af3c5f82e']) {
    expect(buildEvmSchemaBody(findCertifiedEvmSchemaSpec(42161, ARB_USDT, approve(spender))!).toString('hex')).not.toBe(old.entry_hex)
  }
})

describe('the production Worker response is no longer dropped', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  // A minimal legacy Relay depositNative: one signer, the Relay program, a
  // 48-byte instruction (discriminator, u64 lamports, 32-byte order id) over
  // four accounts, the fourth being the vault.
  function relayDepositNativeTx(): string {
    const data = Buffer.concat([Buffer.from('0d9e0ddf5fd51c06', 'hex'), Buffer.alloc(8, 0x01), Buffer.alloc(32, 0x02)])
    const message = Buffer.concat([
      Buffer.from([1, 0, 1]),
      Buffer.from([5]),
      Buffer.alloc(32, 0x10),
      Buffer.alloc(32, 0x11),
      Buffer.alloc(32, 0x12),
      Buffer.alloc(32, 0x13),
      Buffer.from(bs58.decode('99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2')),
      Buffer.alloc(32, 0x20),
      Buffer.from([1, 4, 4, 0, 1, 2, 3, data.length]),
      data,
    ])
    return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64')
  }
  const relayNative = entryByDigest('43aa746f600e13022d721550b16bfc62675d07e3f70179b9c2d133f67b40c047')

  test('certifiedSolanaProofApplies accepts the signed relayDepositNative schema', () => {
    const proof: CertifiedSolanaProof = {
      schema: { payload: relayNative.entry_hex, signature: relayNative.signature_hex, signerKeyId: 0x80 },
      certificate: signed.certificates['501'],
    }
    expect(certifiedSolanaProofApplies(relayDepositNativeTx(), 'relayDepositNative', proof)).toBe(true)
  })

  test('the REST (dapp) path keeps the signed relayDepositNative envelope', async () => {
    const rawTx = relayDepositNativeTx()
    let asked: any
    globalThis.fetch = (async (_url: any, init: any) => {
      asked = JSON.parse(init.body)
      // The shape the production Worker returns for a signed Solana entry.
      return Response.json({
        catalogKey: 'relayDepositNative', success: true, classification: 'VERIFIED',
        schema: { payload: `0x${relayNative.entry_hex}`, signature: `0x${relayNative.signature_hex}`, signerKeyId: 0x80 },
        certificate: `0x${signed.certificates['501']}`, transactionShape: 'legacy', lookupTableCount: 0,
      })
    }) as typeof fetch
    const proof = await prepareExternalSolanaProof({ raw_tx: rawTx }, '7.16.0')
    expect(asked).toEqual({ rawTx, catalogKey: 'relayDepositNative' })
    expect(proof?.schema.payload).toBe(relayNative.entry_hex)
    expect(proof?.certificate).toBe(signed.certificates['501'])
  })

  for (const [digest, { key, chainId, to, calldata }] of Object.entries(EVM_CALLS)) {
    test(`findCertifiedEvmSchema accepts the signed ${key} envelope`, async () => {
      const entry = entryByDigest(digest)
      const method = signedMethod(entry.entry_hex)
      globalThis.fetch = (async (_url: any, init: any) => {
        const asked = JSON.parse(init.body)
        // The fields the production Worker returns for a signed EVM entry.
        return Response.json({
          success: true, classification: 'VERIFIED', version: 3,
          signedPayload: `0x${entry.certified_payload_hex}`, keyId: 0x80, method,
          chainId: asked.chainId, contract: asked.contract.toLowerCase(), selector: asked.selector, expectedCalldataLength: 68,
        })
      }) as typeof fetch
      for (const data of calldata) {
        const result = await findCertifiedEvmSchema(chainId, to, data)
        expect(result?.method).toBe(method)
        expect(result?.signedPayload).toBe(`0x${entry.certified_payload_hex}`)
      }
    })
  }
})
