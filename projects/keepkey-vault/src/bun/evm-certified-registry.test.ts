import { afterEach, describe, expect, test } from 'bun:test'

import { findCertifiedEvmEnvelope } from './evm-certified-registry'
import { DEFAULT_CLEARSIGN_SERVICE_URL } from './solana-certified-registry'

const originalFetch = globalThis.fetch
const originalServiceUrl = process.env.CLEARSIGN_SERVICE_URL
const TO = '0xbf5A7F3629fB325E2a8453D595AB103465F75E62'
const DATA = `0xa2e42c65${'00'.repeat(1472)}`

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalServiceUrl === undefined) delete process.env.CLEARSIGN_SERVICE_URL
  else process.env.CLEARSIGN_SERVICE_URL = originalServiceUrl
})

function verified(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    classification: 'VERIFIED',
    keyId: 0x80,
    chainId: 1,
    contract: TO,
    selector: '0xa2e42c65',
    method: 'Portals swap',
    fingerprint: 'a9531b9d',
    signedPayload: `0x03${'11'.repeat(240)}`,
    ...overrides,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('findCertifiedEvmEnvelope', () => {
  test('uses the production signer after a GUI relaunch with no shell environment', async () => {
    delete process.env.CLEARSIGN_SERVICE_URL
    let requestedUrl = ''
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input)
      return verified()
    }) as typeof fetch

    const result = await findCertifiedEvmEnvelope(1, TO, DATA)
    expect(requestedUrl).toBe(`${DEFAULT_CLEARSIGN_SERVICE_URL}/v1/evm/schema`)
    expect(result?.keyId).toBe(0x80)
  })

  test('sends only the privacy-preserving transaction shape', async () => {
    process.env.CLEARSIGN_SERVICE_URL = 'http://127.0.0.1:1647/'
    let requestBody: any
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body))
      return verified()
    }) as typeof fetch

    const result = await findCertifiedEvmEnvelope(1, TO, DATA)
    expect(requestBody).toEqual({ chainId: 1, contract: TO, selector: '0xa2e42c65', calldataLength: 1476 })
    expect(JSON.stringify(requestBody)).not.toContain(DATA.slice(10))
    expect(result?.keyId).toBe(0x80)
  })

  test('treats a catalog miss as no enhancement', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ classification: 'OPAQUE' }), { status: 422 })) as typeof fetch
    expect(await findCertifiedEvmEnvelope(1, TO, DATA)).toBeUndefined()
  })

  test('rejects wrong bindings or non-certified material before hdwallet', async () => {
    globalThis.fetch = (async () => verified({ chainId: 8453 })) as typeof fetch
    await expect(findCertifiedEvmEnvelope(1, TO, DATA)).rejects.toThrow(/invalid certified EVM envelope/)
    globalThis.fetch = (async () => verified({ keyId: 3 })) as typeof fetch
    await expect(findCertifiedEvmEnvelope(1, TO, DATA)).rejects.toThrow(/invalid certified EVM envelope/)
    globalThis.fetch = (async () => verified({ signedPayload: `0x02${'11'.repeat(240)}` })) as typeof fetch
    await expect(findCertifiedEvmEnvelope(1, TO, DATA)).rejects.toThrow(/invalid certified EVM envelope/)
  })
})
