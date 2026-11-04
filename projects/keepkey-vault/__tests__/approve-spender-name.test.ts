/**
 * Firmware 7.17 (keepkey-firmware #1020) shows a KeepKey-certified 0x06 name
 * beside the spender of an approve it decodes natively. Desktop sends that
 * record instead of the generic token schema, only on 7.17.0 or later.
 *
 * Requests: the swaps.pro approve captured 2026-10-29 (25,000 USDC on
 * Ethereum to CoW's relayer, which has no name record), and the same approve
 * to Uniswap's Universal Router 2.0, which has one. Service answers: real
 * production responses captured 2026-10-30 (fixtures/approve-spender-name).
 */
import { afterEach, describe, expect, it } from 'bun:test'

import swapsPro from '../../../docs/clearsign-case-studies/swapspro-20261029/requests/approve-cow-vaultrelayer.json'
import nameResponse from './fixtures/approve-spender-name/name-ur-v2-chain1.json'
import schemaResponse from './fixtures/approve-spender-name/schema-usdc-approve-chain1.json'
import { resolveEvmSchema } from '../src/bun/evm-schema-registry'
import { firmwareClearSigns } from '../src/bun/calldata-decoder'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const UR_V2 = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af'
const COW_RELAYER = swapsPro.body.data.slice(34, 74)
const toUr = swapsPro.body.data.replace(COW_RELAYER, UR_V2.slice(2))

/** The production ClearSign service as captured: one name, one token schema. */
function service(sent: Array<{ path: string; body: any }>, nameStatus = 200) {
  return (async (url: any, init: any) => {
    const path = new URL(String(url)).pathname
    const body = JSON.parse(init.body)
    sent.push({ path, body })
    if (path === '/v1/evm/name') {
      if (nameStatus !== 200) return Response.json({ error: 'unavailable' }, { status: nameStatus })
      return body.chainId === 1 && body.address === UR_V2
        ? Response.json(nameResponse)
        : Response.json({ classification: 'OPAQUE', code: 'NOT_IN_SIGNED_CATALOG' }, { status: 422 })
    }
    if (path === '/v1/evm/schema' && body.chainId === 1 && body.contract === USDC) return Response.json(schemaResponse)
    return Response.json({ classification: 'OPAQUE' }, { status: 422 })
  }) as unknown as typeof fetch
}

/** Inner body version and the address it names (0x03 | cert(139) | body). */
const body = (payload: string) => {
  const b = Buffer.from(payload.replace(/^0x/, ''), 'hex')
  return { version: b[140], chainId: b.readUInt32BE(141), address: `0x${b.subarray(145, 165).toString('hex')}` }
}

describe('approve spender names (firmware 7.17)', () => {
  it('the requests are a native approve on every firmware this covers', () => {
    expect(swapsPro.body.data.startsWith(`0x095ea7b3${'0'.repeat(24)}c92e8bdf79f0507f65a392b0ab4667716bfe0110`)).toBe(true)
    for (const fw of ['7.16.0', '7.17.0']) {
      expect(firmwareClearSigns(USDC, toUr, 1, fw, '0x0')).toBe(true)
      expect(firmwareClearSigns(USDC, swapsPro.body.data, 1, fw, '0x0')).toBe(true)
    }
  })

  it('on 7.17.0 sends the certified name of a named spender, asking only about that address', async () => {
    const sent: Array<{ path: string; body: any }> = []
    globalThis.fetch = service(sent)
    const schema = await resolveEvmSchema(1, USDC, toUr, true, '7.17.0', '0x0')
    expect(schema?.signedPayload).toBe(nameResponse.signedPayload)
    expect(schema?.keyId).toBe(0x80)
    expect(body(schema!.signedPayload)).toEqual({ version: 0x06, chainId: 1, address: UR_V2 })
    expect(sent).toEqual([{ path: '/v1/evm/name', body: { chainId: 1, address: UR_V2 } }])
  })

  it('on 7.16.0 keeps the token schema it sends today (7.16 ignores a name in SignTx)', async () => {
    const sent: Array<{ path: string; body: any }> = []
    globalThis.fetch = service(sent)
    const schema = await resolveEvmSchema(1, USDC, toUr, true, '7.16.0', '0x0')
    expect(schema?.signedPayload).toBe(schemaResponse.signedPayload)
    expect(body(schema!.signedPayload).version).toBe(0x02)
    expect(sent.map((s) => s.path)).toEqual(['/v1/evm/schema'])
  })

  it('a spender with no certified name keeps the token schema (the swaps.pro request)', async () => {
    const sent: Array<{ path: string; body: any }> = []
    globalThis.fetch = service(sent)
    const schema = await resolveEvmSchema(1, USDC, swapsPro.body.data, true, '7.17.0', swapsPro.body.value)
    expect(schema?.signedPayload).toBe(schemaResponse.signedPayload)
    expect(sent.map((s) => s.path)).toEqual(['/v1/evm/schema'])
  })

  it('never names the spender of an approve the device does not decode natively', async () => {
    const sent: Array<{ path: string; body: any }> = []
    globalThis.fetch = service(sent)
    // Value attached: the firmware does not treat it as a token call.
    await resolveEvmSchema(1, USDC, toUr, true, '7.17.0', '0x1')
    // A token outside the firmware's table: the certified token schema is the only review.
    await resolveEvmSchema(1, '0x1111111111111111111111111111111111111111', toUr, true, '7.17.0', '0x0')
    // The same router address on a chain whose name record is not in Desktop's list.
    await resolveEvmSchema(56, USDC, toUr, true, '7.17.0', '0x0')
    expect(sent.some((s) => s.path === '/v1/evm/name')).toBe(false)
  })

  it('a name lookup failure never blocks: the token schema is sent as before', async () => {
    const sent: Array<{ path: string; body: any }> = []
    globalThis.fetch = service(sent, 503)
    const schema = await resolveEvmSchema(1, USDC, toUr, true, '7.17.0', '0x0')
    expect(schema?.signedPayload).toBe(schemaResponse.signedPayload)
    expect(sent.map((s) => s.path)).toEqual(['/v1/evm/name', '/v1/evm/schema'])
  })

  it('a name for another address or chain is not sent', async () => {
    const sent: Array<{ path: string; body: any }> = []
    globalThis.fetch = (async (url: any, init: any) => {
      sent.push({ path: new URL(String(url)).pathname, body: JSON.parse(init.body) })
      return new URL(String(url)).pathname === '/v1/evm/name'
        ? Response.json({ ...nameResponse, chainId: 8453 })
        : Response.json(schemaResponse)
    }) as unknown as typeof fetch
    const schema = await resolveEvmSchema(1, USDC, toUr, true, '7.17.0', '0x0')
    expect(schema?.signedPayload).toBe(schemaResponse.signedPayload)
  })
})
