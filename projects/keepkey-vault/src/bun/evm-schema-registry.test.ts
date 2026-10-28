import { describe, it, expect } from 'bun:test'
import { findCertifiedEvmSchema, resolveEvmSchema } from './evm-schema-registry'
import { buildTokenSchema } from './evm-token-schema'
import { buildEvmSchemaBody } from './evm-certified-schema'

describe('findCertifiedEvmSchema', () => {
  it('leaves the live USDT approval to the device when its reviewed artifact is unavailable', async () => {
    const originalFetch = globalThis.fetch
    const token = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'
    const approval = `0x095ea7b3${'000000000022d473030f116ddee9f6b43ac78ba3'.padStart(64, '0')}${'ff'.repeat(32)}`
    try {
      for (const status of [422, 503]) {
        globalThis.fetch = (async () => new Response(JSON.stringify({ classification: 'OPAQUE' }), { status })) as typeof fetch
        expect(await findCertifiedEvmSchema(42161, token, approval)).toBeUndefined()
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('requests discovery schemas without sending arguments and rejects altered display metadata', async () => {
    const originalFetch = globalThis.fetch
    const contract = '0x1111111111111111111111111111111111111111'
    const calldata = `0xa9059cbb${'00'.repeat(64)}`
    const tokenIdentity = { chainId: 42161, contract, symbol: 'USDC', decimals: 6,
      source: 'pioneer-discovery', sourceSha256: 'a'.repeat(64) }
    const spec = buildTokenSchema(42161, contract, '0xa9059cbb', 68, tokenIdentity)
    const certificate = Buffer.alloc(139, 0x11)
    certificate.writeUInt32BE(42161, 2)
    const signedPayload = `0x03${certificate.toString('hex')}${buildEvmSchemaBody(spec).toString('hex')}${'22'.repeat(65)}`
    const response = { classification: 'VERIFIED', keyId: 128, signedPayload,
      chainId: 42161, contract, selector: '0xa9059cbb', method: spec.method, expectedCalldataLength: 68, tokenIdentity }
    let sent: any
    try {
      globalThis.fetch = (async (_url: any, init: any) => {
        sent = JSON.parse(init.body)
        return Response.json(response)
      }) as typeof fetch
      expect((await findCertifiedEvmSchema(42161, contract, calldata))?.method).toBe('USDC transfer')
      expect(sent).toEqual({ chainId: 42161, contract, selector: '0xa9059cbb', calldataLength: 68 })
      const wrongScope = Buffer.from(signedPayload.slice(2), 'hex')
      wrongScope.writeUInt32BE(1, 3)
      globalThis.fetch = (async () => Response.json({ ...response, signedPayload: `0x${wrongScope.toString('hex')}` })) as typeof fetch
      await expect(findCertifiedEvmSchema(42161, contract, calldata)).rejects.toThrow(/not authorized for chain 42161/)
      for (const token of [{ ...tokenIdentity, decimals: 18 }, { ...tokenIdentity, symbol: 'USDT' }, { ...tokenIdentity, chainId: 1 }]) {
        globalThis.fetch = (async () => Response.json({ ...response, tokenIdentity: token })) as typeof fetch
        await expect(findCertifiedEvmSchema(42161, contract, calldata)).rejects.toThrow(/token identity/)
      }
      // A symbol firmware refuses is no description, not a signing error.
      globalThis.fetch = (async () => Response.json({ ...response, tokenIdentity: { ...tokenIdentity, symbol: 'USD+' } })) as unknown as typeof fetch
      expect(await findCertifiedEvmSchema(42161, contract, calldata)).toBeUndefined()
      globalThis.fetch = (async () => Response.json({ classification: 'OPAQUE', code: 'TOKEN_IDENTITY_UNVERIFIED' }, { status: 422 })) as typeof fetch
      expect(await findCertifiedEvmSchema(42161, contract, calldata)).toBeUndefined()
    } finally { globalThis.fetch = originalFetch }
  })

  it('a reviewed call the service cannot certify goes to the device without a certificate', async () => {
    const originalFetch = globalThis.fetch
    // Relay depositNative on Base: reviewed here, absent from the deployed service.
    const relay = ['0x4cd00e387622c35bddb9b4c962c136462338bc31', `0x49290c1c${'00'.repeat(64)}`] as const
    try {
      globalThis.fetch = (async () => Response.json({ classification: 'OPAQUE', error: 'not in the reviewed catalog' }, { status: 422 })) as typeof fetch
      expect(await resolveEvmSchema(8453, ...relay)).toBeUndefined()
      globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch
      expect(await resolveEvmSchema(8453, ...relay)).toBeUndefined()
      globalThis.fetch = (async () => new Response('bad gateway', { status: 502 })) as typeof fetch
      expect(await resolveEvmSchema(8453, ...relay)).toBeUndefined()
    } finally { globalThis.fetch = originalFetch }
  })

})

describe('resolveEvmSchema has no local stand-in', () => {
  it('chain 1 Relay bridgeDeposit with the service down: no schema', async () => {
    const TO = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
    const DATA = '0x49290c1c' + '00'.repeat(64)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    try {
      expect(await resolveEvmSchema(1, TO, DATA, true)).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
