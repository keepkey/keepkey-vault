import { afterEach, describe, expect, test } from 'bun:test'

import { findCertifiedSolanaProof } from './solana-certified-registry'

const originalFetch = globalThis.fetch
const originalServiceUrl = process.env.CLEARSIGN_SERVICE_URL

function verifiedResponse(lutProof?: unknown): Response {
  return new Response(JSON.stringify({
    classification: 'VERIFIED',
    ...(lutProof === undefined ? {} : { lutProof }),
    schema: {
      payload: '0x4b4b534f4c534331',
      signature: `0x${'22'.repeat(64)}`,
      signerKeyId: 0x80,
    },
    certificate: `0x${'33'.repeat(139)}`,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalServiceUrl === undefined) delete process.env.CLEARSIGN_SERVICE_URL
  else process.env.CLEARSIGN_SERVICE_URL = originalServiceUrl
})

describe('findCertifiedSolanaProof', () => {
  test('accepts a schema-only certified response for a self-contained transaction', async () => {
    process.env.CLEARSIGN_SERVICE_URL = 'http://127.0.0.1:1647/'
    globalThis.fetch = (async () => verifiedResponse()) as typeof fetch

    const result = await findCertifiedSolanaProof('unsigned-fixture', 'relayDepositNative')
    expect(result?.lutProof).toBeUndefined()
    expect(result?.schema.signerKeyId).toBe(0x80)
    expect(result?.schema.payload).toBe('4b4b534f4c534331')
    expect(result?.certificate).toHaveLength(139 * 2)
  })

  test('preserves a nonempty LUT proof for an ALT-backed transaction', async () => {
    process.env.CLEARSIGN_SERVICE_URL = 'http://127.0.0.1:1647'
    globalThis.fetch = (async () => verifiedResponse({
      accounts: [Buffer.alloc(32, 0x11).toString('base64')],
      signature: `0x${'44'.repeat(64)}`,
      signerKeyId: 0x80,
    })) as typeof fetch

    const result = await findCertifiedSolanaProof('unsigned-fixture', 'relayDepositNative')
    expect(result?.lutProof?.accounts).toHaveLength(1)
    expect(result?.lutProof?.signature).toBe('44'.repeat(64))
  })

  test('rejects an empty or partial LUT proof instead of treating it as schema-only', async () => {
    process.env.CLEARSIGN_SERVICE_URL = 'http://127.0.0.1:1647'
    globalThis.fetch = (async () => verifiedResponse({
      accounts: [],
      signature: `0x${'44'.repeat(64)}`,
      signerKeyId: 0x80,
    })) as typeof fetch

    await expect(findCertifiedSolanaProof('unsigned-fixture', 'relayDepositNative'))
      .rejects.toThrow(/partial LUT proof/)
  })

  test('rejects malformed service material before it reaches hdwallet', async () => {
    process.env.CLEARSIGN_SERVICE_URL = 'http://127.0.0.1:1647'
    globalThis.fetch = (async () => {
      const response = verifiedResponse()
      const body = await response.json() as any
      body.schema.signerKeyId = 3
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
    await expect(findCertifiedSolanaProof('unsigned-fixture', 'relayDepositNative'))
      .rejects.toThrow(/non-certified signer id/)

    globalThis.fetch = (async () => verifiedResponse({
      accounts: [Buffer.alloc(31).toString('base64')],
      signature: `0x${'44'.repeat(64)}`,
      signerKeyId: 0x80,
    })) as typeof fetch
    await expect(findCertifiedSolanaProof('unsigned-fixture', 'relayDepositNative'))
      .rejects.toThrow(/invalid LUT account/)
  })
})
