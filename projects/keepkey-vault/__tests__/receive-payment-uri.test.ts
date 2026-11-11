import { beforeAll, expect, test } from 'bun:test'
import { receivePaymentUri } from '../src/shared/receive-payment-uri'

let result: Record<string, any>
beforeAll(() => {
  const child = Bun.spawnSync([process.execPath, new URL('./support/receive-payment-uri.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  })
  if (child.exitCode) throw new Error(child.stderr.toString() || child.stdout.toString())
  result = JSON.parse(child.stdout.toString().trim().split('\n').at(-1)!)
}, 30_000) // the child renders under jsdom and is allowed 30 s; Bun's 5 s hook default failed under load

for (const [name, scheme] of Object.entries({ bitcoin: 'bitcoin', litecoin: 'litecoin', dogecoin: 'dogecoin', dash: 'dash', digibyte: 'digibyte', zcash: 'zcash', bitcoincash: 'bitcoincash' })) {
  test(`${name} receive QR identifies the payment network while display and clipboard keep the address`, () => {
    const value = result[name]
    expect(value.qr).toBe(`${scheme}:${value.address}`)
    expect(value.displayed).toBe(value.address)
    expect(value.copied).toBe(value.address)
  })
}
test('already-prefixed BCH cashaddr appears exactly once, including uppercase cashaddr', () => {
  for (const name of ['cashaddr-prefixed', 'cashaddr-uppercase']) {
    const value = result[name]
    expect(value.qr).toBe(value.address)
    expect(value.copied).toBe(value.address)
    expect(value.qr.toLowerCase().match(/bitcoincash:/g)).toHaveLength(1)
  }
})
test('EVM native and token requests retain EIP-681 network and contract semantics', () => {
  expect(result.ethereum.qr).toBe(`ethereum:${result.ethereum.address}@1`)
  expect(result['base-token'].qr).toBe(`ethereum:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453/transfer?address=${result['base-token'].address}`)
  expect(result['base-token'].copied).toBe(result['base-token'].address)
  expect(result.evmMismatch).toEqual({ qr: null, alert: true })
})
test('Solana keeps its existing scheme and unvetted networks stay raw without invented fields', () => {
  expect(result.solana.qr).toBe(`solana:${result.solana.address}`)
  for (const name of ['ripple', 'cosmos', 'thorchain', 'hive']) {
    expect(result[name].qr).toBe(result[name].address)
    expect(result[name].copied).toBe(result[name].address)
  }
  expect(result.deviceCalls).toEqual([])
})
test('unrecognized chain identifiers stay raw and invalid EVM requests still fail closed', () => {
  const chain = { id: 'constructor', chainFamily: 'cosmos' as const, networkId: 'cosmos:custom', caip: 'cosmos:custom/slip44:118' }
  expect(receivePaymentUri(chain, 'unchanged-address')).toBe('unchanged-address')
  const ethereum = { id: 'ethereum', chainFamily: 'evm' as const, networkId: 'eip155:1', caip: 'eip155:1/slip44:60' }
  expect(() => receivePaymentUri(ethereum, 'invalid-evm-account')).toThrow('Receive account and asset must belong to the same EVM network')
  expect(() => receivePaymentUri(ethereum, '0x1234567890123456789012345678901234567890', 'eip155:1/unsupported:token')).toThrow('Unsupported receive asset identifier')
})
