import { describe, it, expect } from 'bun:test'
import { findEvmSchema, findCertifiedEvmSchema, resolveEvmSchema } from './evm-schema-registry'
import { buildTokenSchema } from './evm-token-schema'
import { buildEvmSchemaBody } from './evm-certified-schema'

/* The exact Relay ETH->Solana bridge deposit captured from api.relay.link on
 * 2026-07-27 — the transaction that used to blind-sign. */
const TO = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
const DATA =
  '0x49290c1c' +
  '000000000000000000000000909ef6b32dfdc12ca86aa710b54c991af3c5f82e' +
  '8a2c121197efc95c42f53142ab409735ee353287f877ed4d351f63094d5bfcb1'

describe('findEvmSchema', () => {
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

  it('matches the real Relay bridge deposit', () => {
    const hit = findEvmSchema(1, TO, DATA)
    expect(hit).toBeDefined()
    expect(hit!.method).toBe('bridgeDeposit')
    expect(hit!.signedPayload.startsWith('0x')).toBe(true)
    // 4-byte selector + 2 words
    expect(hit!.expectedCalldataLength).toBe(68)
    expect((DATA.length - 2) / 2).toBe(hit!.expectedCalldataLength)
  })

  it('is case-insensitive on the contract address', () => {
    expect(findEvmSchema(1, TO.toUpperCase(), DATA)).toBeDefined()
  })

  /* A schema authorises a specific decode. Matching too loosely would let the
   * device render one method's labels over another call's bytes, so every
   * component of the key must be required. */
  it('does not match a different chain, contract, or selector', () => {
    expect(findEvmSchema(8453, TO, DATA)).toBeUndefined()
    expect(findEvmSchema(1, '0x0000000000000000000000000000000000000001', DATA)).toBeUndefined()
    expect(findEvmSchema(1, TO, '0xdeadbeef' + DATA.slice(10))).toBeUndefined()
  })

  /* Firmware requires declared arg widths to account for the calldata exactly;
   * refusing here avoids a confusing mid-signing rejection on the device. */
  it('rejects calldata whose length does not match the schema', () => {
    expect(findEvmSchema(1, TO, DATA + 'ab'.repeat(32))).toBeUndefined()
    expect(findEvmSchema(1, TO, DATA.slice(0, 42))).toBeUndefined()
  })

  it('returns undefined on missing input rather than throwing', () => {
    expect(findEvmSchema(undefined, TO, DATA)).toBeUndefined()
    expect(findEvmSchema(1, undefined, DATA)).toBeUndefined()
    expect(findEvmSchema(1, TO, undefined)).toBeUndefined()
    expect(findEvmSchema(1, TO, '0x')).toBeUndefined()
  })
})

describe('resolveEvmSchema never stands in the CI test-key registry', () => {
  it('chain 1 Relay bridgeDeposit with the service down: no schema, not the slot-3 entry', async () => {
    const TO = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
    const DATA = '0x49290c1c' + '00'.repeat(64)
    expect(findEvmSchema(1, TO, DATA)?.keyId).toBe(3)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    try {
      expect(await resolveEvmSchema(1, TO, DATA, true)).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
