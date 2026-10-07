import { afterEach, describe, expect, it } from 'bun:test'

import worker from '../clearsign-worker/src/index'
import { buildEvmDecoderBody, buildEvmNameBody, findEvmNameRecord, findReviewedUniversalRouter, reviewedSwapTokens } from '../src/bun/evm-certified-schema'
import { permit2Spender, permit2SpenderNameMetadata } from '../src/bun/permit2-spender-name'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

// Uniswap's request from the owner's Vault log (2026-04-10).
const UNISWAP = {
  primaryType: 'PermitSingle',
  domain: { name: 'Permit2', chainId: '1', verifyingContract: '0x000000000022d473030f116ddee9f6b43ac78ba3' },
  message: {
    details: { token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', amount: '1461501637330902918203684832716283019655932542975', expiration: '1778393946', nonce: '0' },
    spender: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af',
    sigDeadline: '1775803746',
  },
}

describe('Permit2 spender names', () => {
  it('recognizes only a canonical Permit2 PermitSingle', () => {
    expect(permit2Spender(UNISWAP)).toEqual({ chainId: 1, spender: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af', token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' })
    expect(permit2Spender({ ...UNISWAP, primaryType: 'PermitBatch' })).toBeUndefined()
    expect(permit2Spender({ ...UNISWAP, domain: { ...UNISWAP.domain, verifyingContract: '0x1111111111111111111111111111111111111111' } })).toBeUndefined()
    expect(permit2Spender({ ...UNISWAP, message: { ...UNISWAP.message, spender: 'nope' } })).toBeUndefined()
  })

  it('never asks the service before 7.16 or about an address outside the reviewed catalog', async () => {
    // Both return before any network call: there is nothing to look up.
    expect(await permit2SpenderNameMetadata(UNISWAP, '7.15.0')).toBeUndefined()
    const unknown = { ...UNISWAP, message: { ...UNISWAP.message, spender: '0x2222222222222222222222222222222222222222' } }
    expect(await permit2SpenderNameMetadata(unknown, '7.16.0')).toBeUndefined()
  })
})

// The PermitSingle the owner signed on Base on 2026-10-04 (Desktop log,
// 04:05:49Z): cbBTC to Uniswap's Universal Router 2.1.2, max uint160.
const CBBTC_PERMIT = {
  primaryType: 'PermitSingle',
  domain: { name: 'Permit2', chainId: '8453', verifyingContract: '0x000000000022d473030f116ddee9f6b43ac78ba3' },
  message: {
    details: { token: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', amount: '1461501637330902918203684832716283019655932542975', expiration: '1793765127', nonce: '0' },
    spender: '0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40',
    sigDeadline: '1791174927',
  },
}
const UR_212 = '0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40'
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'

/** The ClearSign service for reviewed entries: the real catalog body inside a
 * stand-in certificate and signature (the device, not Desktop, checks those). */
function service(sent: Array<{ path: string; body: any }>, swap: 'verified' | 'opaque' = 'verified') {
  return (async (url: any, init: any) => {
    const path = new URL(String(url)).pathname
    const body = JSON.parse(init.body)
    sent.push({ path, body })
    const certificate = Buffer.alloc(139, 0x11)
    certificate.writeUInt32BE(body.chainId, 2)
    const envelope = (b: Buffer) => `0x03${certificate.toString('hex')}${b.toString('hex')}${'22'.repeat(65)}`
    if (path === '/v1/evm/swap') {
      const router = findReviewedUniversalRouter(body.chainId, body.contract)
      const tokens = reviewedSwapTokens(body.chainId, body.tokens)
      if (swap === 'opaque' || !router || !tokens) return Response.json({ classification: 'OPAQUE' }, { status: 422 })
      return Response.json({
        classification: 'VERIFIED', keyId: 0x80, chainId: body.chainId, entry: `eip155:${body.chainId}:${router.address}:uniswap-ur`,
        signedPayload: envelope(buildEvmDecoderBody(body.chainId, router.address, body.selector, tokens)),
      })
    }
    const record = findEvmNameRecord(body.chainId, body.address)
    if (!record) return Response.json({ classification: 'OPAQUE' }, { status: 422 })
    return Response.json({
      classification: 'VERIFIED', keyId: 0x80, chainId: record.chainId, address: record.address,
      signedPayload: envelope(buildEvmNameBody(record)),
    })
  }) as unknown as typeof fetch
}

describe('Permit2 PermitSingle token names (firmware 7.16 F-D)', () => {
  it('sends the router\'s certified 0x07 entry naming cbBTC for the real Base permit', async () => {
    const sent: Array<{ path: string; body: any }> = []
    globalThis.fetch = service(sent)
    const metadata = await permit2SpenderNameMetadata(CBBTC_PERMIT, '7.16.0')
    // Only the router, an execute() selector and the permit's token leave the host.
    expect(sent).toEqual([{ path: '/v1/evm/swap', body: { chainId: 8453, contract: UR_212, selector: '0x3593564c', tokens: [CBBTC] } }])
    expect(metadata?.keyId).toBe(0x80)
    const body = Buffer.from(metadata!.signedPayload.slice(2), 'hex').subarray(140, -65)
    expect(body[0]).toBe(0x07)
    expect(body.equals(buildEvmDecoderBody(8453, UR_212, '0x3593564c', [{ address: CBBTC, symbol: 'cbBTC', decimals: 8 }]))).toBe(true)
  })

  it('the live worker accepts that exact request (refused only for lack of the chain certificate here)', async () => {
    const response = await worker.fetch(new Request('https://clearsign.example/v1/evm/swap', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chainId: 8453, contract: UR_212, selector: '0x3593564c', tokens: [CBBTC] }),
    }), {})
    expect(response.status).toBe(503)
    expect((await response.json() as any).entry).toBe(`eip155:8453:${UR_212}:uniswap-ur`)
  })

  it('keeps the 0x06 spender name when no 0x07 entry is certified', async () => {
    const sent: Array<{ path: string; body: any }> = []
    globalThis.fetch = service(sent, 'opaque')
    const metadata = await permit2SpenderNameMetadata(CBBTC_PERMIT, '7.16.0')
    expect(sent.map((s) => s.path)).toEqual(['/v1/evm/swap', '/v1/evm/name'])
    expect(Buffer.from(metadata!.signedPayload.slice(2), 'hex')[140]).toBe(0x06)
  })

  it('asks only for the name when the permit token is not reviewed on that chain', async () => {
    const sent: Array<{ path: string; body: any }> = []
    globalThis.fetch = service(sent)
    const unreviewed = { ...CBBTC_PERMIT, message: { ...CBBTC_PERMIT.message, details: { ...CBBTC_PERMIT.message.details, token: '0x41b481c3d2e3960f8f312212adfeecf6ce7c35ef' } } }
    const metadata = await permit2SpenderNameMetadata(unreviewed, '7.16.0')
    expect(sent).toEqual([{ path: '/v1/evm/name', body: { chainId: 8453, address: UR_212 } }])
    expect(Buffer.from(metadata!.signedPayload.slice(2), 'hex')[140]).toBe(0x06)
  })
})
