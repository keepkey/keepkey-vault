import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { secp256k1 } from '@noble/curves/secp256k1'
import { utils as ethersUtils } from 'ethers'

import fixtures from '../../keepkey-sdk/tests/fixtures/evm-clearsign-vendored.js'
import { buildUniswapRuntimeEnvelope, createUniswapRuntimeProvider, runtimeEvmSighash, uniswapRuntimePages } from '../src/bun/uniswap-runtime-envelope'

const flow = (fixtures as any)['uniswap-live-eth-usdc-universal-router']
const tx = {
  chainId: 1,
  to: `0x${flow.to}`,
  data: `0x${flow.calldata}`,
  value: `0x${BigInt(flow.value).toString(16)}`,
  nonce: '0x7',
  gasLimit: '0x7a120',
  maxFeePerGas: '0x77359400',
  maxPriorityFeePerGas: '0x3b9aca00',
}

describe('transaction-bound Uniswap runtime envelope', () => {
  test('renders the live Arbitrum Permit2 + V3 USDT-to-native route', () => {
    const iface = new ethersUtils.Interface(['function execute(bytes commands,bytes[] inputs,uint256 deadline)'])
    const usdt = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'
    const usdc = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
    const weth = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1'
    const router = '0x2d01411773c8c24805306e89a41f7855c3c4fe65'
    const sender = '0x909Ef6B32DfDc12CA86aA710b54c991af3C5F82E'
    const permit = ethersUtils.defaultAbiCoder.encode([
      'tuple(tuple(address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline)', 'bytes',
    ], [{ details: { token: usdt, amount: `0x${'ff'.repeat(20)}`, expiration: 1792602025, nonce: 0 }, spender: router, sigDeadline: 1790011825 }, `0x${'11'.repeat(65)}`])
    const swap = ethersUtils.defaultAbiCoder.encode(
      ['address', 'uint256', 'uint256', 'bytes', 'bool', 'uint256[]'],
      ['0x0000000000000000000000000000000000000002', 9574651, 0, `${usdt}000064${usdc.slice(2)}000064${weth.slice(2)}`, true, []],
    )
    const unwrap = ethersUtils.defaultAbiCoder.encode(['address', 'uint256'], [sender, 3391092029663169n])
    const data = `${iface.encodeFunctionData('execute', ['0x0a000c', [permit, swap, unwrap], 1790011835])}756e6978000001a0c4e963268000a6030000000c0100`
    const rendered = uniswapRuntimePages({ ...tx, chainId: 42161, from: sender, to: router, value: '0', data })
    expect(rendered).toMatchObject({ method: 'Uniswap v3 exact-input swap', fields: [
      { name: 'Protocol', value: 'Uniswap v3' },
      { name: 'Input asset', value: 'Arbitrum USDT' },
      { name: 'Input token', value: usdt },
      { name: 'Spend', value: '9574651' },
      { name: 'Output asset', value: 'Native ETH' },
      { name: 'Receive at least', value: '3391092029663169' },
      { name: 'Recipient', value: sender },
      { name: 'Deadline', value: '1790011835' },
    ] })
    expect(() => uniswapRuntimePages({ ...tx, chainId: 42161, from: sender, to: router, value: '0', data: `${data.slice(0, -4)}0200` }))
      .toThrow('not a recognized official Uniswap call')
  })

  test('fits the live exact-input swap into all eight honest device fields', () => {
    const rendered = uniswapRuntimePages(tx)
    expect(rendered.method).toBe('Uniswap exact-input swap')
    expect(rendered.fields).toEqual([
      { name: 'Route', value: 'WRAP>V2_EXACT_IN>SWEEP' },
      { name: 'Deadline', value: '1800000000' },
      { name: 'Spend wei', value: '100000000000000' },
      { name: 'Receive at least', value: '257170' },
      { name: 'Input token', value: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
      { name: 'Output token', value: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
      { name: 'Recipient', value: '0x742d35cc6634c0532950a20547b231011e30c8e7' },
      { name: 'Payer', value: 'router' },
    ])
    expect(rendered.fields.every(field => Buffer.byteLength(field.name) <= 32 && Buffer.byteLength(field.value) <= 44)).toBe(true)
  })

  test('renders canonical direct V2 exact-input and exact-output swaps without generic text chunking', () => {
    const iface = new ethersUtils.Interface([
      'function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline)',
      'function swapTokensForExactTokens(uint256 amountOut,uint256 amountInMax,address[] path,address to,uint256 deadline)',
    ])
    const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
    const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    const recipient = '0x909Ef6B32DfDc12CA86aA710b54c991af3C5F82E'
    const router = '0x7a250d5630b4cf539739df2c5dacab4c659f2488d'
    const exactIn = uniswapRuntimePages({
      ...tx, to: router, value: '1234',
      data: iface.encodeFunctionData('swapExactETHForTokens', [250000, [weth, usdc], recipient, 1800000000]),
    })
    expect(exactIn).toMatchObject({ method: 'Uniswap direct swap', fields: [
      { name: 'Action', value: 'Exact input swap' },
      { name: 'Spend', value: '1234' },
      { name: 'Receive at least', value: '250000' },
      { name: 'Input token', value: weth.toLowerCase() },
      { name: 'Output token', value: usdc.toLowerCase() },
      { name: 'Recipient', value: recipient.toLowerCase() },
      { name: 'Deadline', value: '1800000000' },
      { name: 'Input kind', value: 'native value' },
    ] })

    const exactOut = uniswapRuntimePages({
      ...tx, to: router, value: '0',
      data: iface.encodeFunctionData('swapTokensForExactTokens', [250000, 1234, [weth, usdc], recipient, 1800000000]),
    })
    expect(exactOut.fields).toEqual([
      { name: 'Action', value: 'Exact output swap' },
      { name: 'Spend at most', value: '1234' },
      { name: 'Receive', value: '250000' },
      { name: 'Input token', value: weth.toLowerCase() },
      { name: 'Output token', value: usdc.toLowerCase() },
      { name: 'Recipient', value: recipient.toLowerCase() },
      { name: 'Deadline', value: '1800000000' },
      { name: 'Input kind', value: 'ERC-20 allowance' },
    ])
  })

  test('binds the Arbitrum USDT identity into the device Permit2 approval', () => {
    const iface = new ethersUtils.Interface(['function approve(address spender,uint256 amount)'])
    const approval = uniswapRuntimePages({
      ...tx,
      chainId: 42161,
      to: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
      value: '0',
      data: iface.encodeFunctionData('approve', [
        '0x000000000022D473030F116dDEE9F6B43aC78BA3',
        '115792089237316195423570985008687907853269984665640564039457584007913129639935',
      ]),
    })
    expect(approval).toEqual({
      method: 'Uniswap Permit2 approval',
      pages: ['Uniswap Permit2', 'Arbitrum One', 'USDT', '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', '0x000000000022d473030f116ddee9f6b43ac78ba3', 'Unlimited', 'Until revoked'],
      fields: [
        { name: 'Protocol', value: 'Uniswap Permit2' },
        { name: 'Network', value: 'Arbitrum One' },
        { name: 'Token', value: 'USDT' },
        { name: 'Token contract', value: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9' },
        { name: 'Spender', value: '0x000000000022d473030f116ddee9f6b43ac78ba3' },
        { name: 'Allowance', value: 'Unlimited' },
        { name: 'Duration', value: 'Until revoked' },
      ],
    })
  })

  test('signs a recoverable v1 blob bound to every final transaction field', () => {
    const privateKey = new Uint8Array(32).fill(7)
    const built = buildUniswapRuntimeEnvelope(tx, 2, privateKey, 1800000000)
    const bytes = Buffer.from(built.signedPayload.slice(2), 'hex')
    const body = bytes.subarray(0, -65)
    const signature = bytes.subarray(-65, -1)
    const recovery = bytes[bytes.length - 1] - 27
    const recovered = secp256k1.Signature.fromCompact(signature).addRecoveryBit(recovery)
      .recoverPublicKey(createHash('sha256').update(body).digest()).toRawBytes(true)
    expect(Buffer.from(recovered).toString('hex')).toBe(Buffer.from(secp256k1.getPublicKey(privateKey, true)).toString('hex'))
    expect(built.txHash).toBe(`0x${runtimeEvmSighash(tx).toString('hex')}`)
    expect(runtimeEvmSighash({ ...tx, nonce: '0x8' }).equals(runtimeEvmSighash(tx))).toBe(false)
    expect(runtimeEvmSighash({ ...tx, maxFeePerGas: '0x77359401' }).equals(runtimeEvmSighash(tx))).toBe(false)
  })

  test('refuses unknown identities, incomplete programs, and ambiguous fee models', () => {
    expect(() => uniswapRuntimePages({ ...tx, to: '0x1111111111111111111111111111111111111111' })).toThrow('not a recognized official Uniswap call')
    expect(() => uniswapRuntimePages({ ...tx, data: `${tx.data}00` })).toThrow('not a recognized official Uniswap call')
    expect(() => runtimeEvmSighash({ ...tx, gasPrice: '0x1' })).toThrow('mixes')
    expect(() => runtimeEvmSighash({ ...tx, maxPriorityFeePerGas: undefined })).toThrow('requires both')
  })

  test('provider exposes its trust identity and returns 422 instead of signing opaque calls', async () => {
    const privateKey = new Uint8Array(32).fill(9)
    const publicKeyHex = Buffer.from(secp256k1.getPublicKey(privateKey, true)).toString('hex')
    const fingerprint = createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 8)
    const provider = createUniswapRuntimeProvider({ alias: 'Uniswap Live Audit', keyId: 3, privateKeyHex: Buffer.from(privateKey).toString('hex'), publicKeyHex, fingerprint })
    expect(await (await provider(new Request('http://provider/signer'))).json()).toMatchObject({ alias: 'Uniswap Live Audit', keyId: 3, publicKeyHex, fingerprint })
    const signed = await provider(new Request('http://provider/sign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tx) }))
    expect(signed.status).toBe(200)
    expect(await signed.json()).toMatchObject({ classification: 'VERIFIED', keyId: 3 })
    const opaque = await provider(new Request('http://provider/sign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...tx, to: '0x1111111111111111111111111111111111111111' }) }))
    expect(opaque.status).toBe(422)
    expect(await opaque.json()).toMatchObject({ classification: 'OPAQUE' })
  })
})
