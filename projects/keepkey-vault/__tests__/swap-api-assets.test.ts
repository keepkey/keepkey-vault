import { expect, test } from 'bun:test'
import { resolveSwapAsset, swapAssetKey } from '../src/bun/swap-asset-resolver'
import { CHAINS } from '../src/shared/chains'
import { handleSwapRoute } from '../src/bun/rest-swap'
import { SwapQuoteHeadlessRequest } from '../src/bun/schemas'
const usdc = 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const resolve = (key: string) => resolveSwapAsset(key, { assets: [], firmwareVersion: '7.17.0' })
test('indexed USDC and native chains absent from the pool shortlist resolve by CAIP', async () => {
  expect(await resolve(usdc.toUpperCase().replace('EIP155', 'eip155').replace('ERC20', 'erc20'))).toMatchObject({ caip: usdc, decimals: 6, chainId: 'ethereum' })
  for (const id of ['gnosis', 'cosmos', 'osmosis']) {
    const chain = CHAINS.find(c => c.id === id)!
    expect(await resolve(chain.caip)).toMatchObject({ caip: chain.caip, chainId: id, decimals: chain.decimals })
  }
})
test('firmware restrictions apply even when native metadata is known', async () => {
  const zec = CHAINS.find(c => c.id === 'zcash')!
  expect(await resolveSwapAsset(zec.caip, { assets: [], firmwareVersion: '7.14.0' })).toBeNull()
})
test('unknown EVM tokens require verified decimal metadata; malformed tokens never invoke lookup', async () => {
  const token = 'eip155:1/erc20:0x1111111111111111111111111111111111111111'
  let calls = 0
  const options = { assets: [], tokenDecimals: async () => { calls++; return 8 } }
  expect(await resolveSwapAsset(token, options)).toMatchObject({ caip: token, decimals: 8 })
  for (const key of ['eip155:999999/erc20:0x1111111111111111111111111111111111111111', 'eip155:1/erc20:bad', 'eip155:1/slip44:99999']) expect(await resolveSwapAsset(key, options)).toBeNull()
  expect(calls).toBe(1)
  expect(await resolveSwapAsset(token, { assets: [] })).toBeNull()
})
test('base58 token identifiers remain case sensitive', () => {
  const caip = 'tron:0x2b6653dc/token:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
  expect(swapAssetKey(caip)).toBe(caip)
  expect(swapAssetKey(caip.toLowerCase())).not.toBe(caip)
})
async function route(command: string, body: any, callbacks: any) {
  return handleSwapRoute(`/api/v2/swap/${command}`, 'POST', new Request(`http://localhost/api/v2/swap/${command}`, { method: 'POST', body: JSON.stringify(body) }),
    { requireAuth: () => ({}) } as any, (data, status = 200) => Response.json(data, { status }), callbacks)
}
test('REST quotes accept valid tokens without relying on the short picker list', async () => {
  let received: any
  const response = await route('quote', { fromCaip: usdc, toCaip: CHAINS.find(c => c.id === 'ripple')!.caip, amount: '3', fromAddress: 'sender', toAddress: 'recipient' },
    { resolveSwapAsset: resolve, getSwapQuoteHeadless: async (params: any) => { received = params; return {} } })
  expect(response?.status).toBe(200)
  expect(received.fromCaip).toBe(usdc)
})
test('UI seeds carry server metadata and discard caller-forged definitions and command kind', async () => {
  for (const command of ['open', 'set']) {
    const sent: any[] = []
    expect((await route(command, { kind: 'confirm', fromAsset: usdc, fromAssetDefinition: { decimals: 18 }, toAssetDefinition: { caip: 'forged' } },
      { resolveSwapAsset: resolve, sendSwapCmd: (cmd: any) => sent.push(cmd) }))?.status).toBe(200)
    expect(sent[0].kind).toBe(command)
    expect(sent[0].fromAssetDefinition).toMatchObject({ caip: usdc, decimals: 6 })
    expect(sent[0].toAssetDefinition).toBeUndefined()
  }
})
test('unsupported assets fail before sending a UI command or fetching a quote', async () => {
  let called = false
  const response = await route('open', { fromAsset: 'unknown:asset' }, { resolveSwapAsset: resolve, sendSwapCmd: () => { called = true } })
  expect(response?.status).toBe(400)
  expect(called).toBe(false)
})
test('malformed amounts are rejected at the API schema instead of reaching providers', () => {
  for (const amount of ['0', '-1', '1garbage', '1e2', 'NaN', 'Infinity', ' 1', '1,000', '0.' + '0'.repeat(199) + '1']) {
    expect(SwapQuoteHeadlessRequest.safeParse({ fromCaip: usdc, toCaip: usdc, amount, fromAddress: 'sender', toAddress: 'recipient' }).success).toBe(false)
  }
})
