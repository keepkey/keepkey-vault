import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { buildEvmTx } from '../src/bun/txbuilder/evm'
import { CHAINS } from '../src/shared/chains'

const ethereum = CHAINS.find(c => c.id === 'ethereum')!
const arbitrum = CHAINS.find(c => c.id === 'arbitrum')!
const fromAddress = '0x000000000000000000000000000000000000bEEF'
const toAddress = '0x000000000000000000000000000000000000dEaD'
const tokenAddress = '0x000000000000000000000000000000000000c0fe'

const pioneerWithBalance = (balance: string) => ({
  GetGasPriceByNetwork: async () => ({ data: '1' }),
  GetNonceByNetwork: async () => ({ data: { nonce: 7 } }),
  GetBalanceAddressByNetwork: async () => ({ data: { balance } }),
})

let originalFetch: typeof fetch
// Arbitrum estimates against its sequencer RPC; keep the suite offline — a
// failed estimate falls back to the floor.
beforeEach(() => { originalFetch = globalThis.fetch; globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch })
afterEach(() => { globalThis.fetch = originalFetch })

describe('EVM max send', () => {
  test('rejects native max sends that cannot cover the rounded gas reserve', async () => {
    await expect(buildEvmTx(pioneerWithBalance('0.000022'), ethereum, {
      to: toAddress,
      amount: '0',
      isMax: true,
      fromAddress,
    })).rejects.toThrow('Insufficient funds to cover gas fees')
  })

  test('native max subtracts a rounded 10% gas reserve from balance', async () => {
    const result = await buildEvmTx(pioneerWithBalance('0.1'), ethereum, {
      to: toAddress,
      amount: '0',
      isMax: true,
      fromAddress,
    })

    const gasFee = 21_000n * 1_000_000_000n
    const gasReserve = (gasFee * 110n + 99n) / 100n

    expect(BigInt(result.value)).toBe(100_000_000_000_000_000n - gasReserve)
    expect(result.gasLimit).toBe('0x5208')
    expect(result.gasPrice).toBe('0x3b9aca00')
  })

  test('ERC-20 max reserves one display quantum before encoding transfer amount', async () => {
    const result = await buildEvmTx(pioneerWithBalance('1'), ethereum, {
      to: toAddress,
      amount: '0',
      isMax: true,
      fromAddress,
      caip: `eip155:1/erc20:${tokenAddress}`,
      tokenBalance: '27.49591932',
      tokenDecimals: 18,
    })

    expect(result.to).toBe(tokenAddress)
    expect(BigInt(`0x${result.data.slice(-64)}`)).toBe(27_495_919_310_000_000_000n)
  })

  test('Arbitrum native transfers never use the invalid 21000 gas limit', async () => {
    const result = await buildEvmTx(pioneerWithBalance('1'), arbitrum, {
      to: toAddress,
      amount: '0.01',
      fromAddress,
    })
    expect(BigInt(result.gasLimit)).toBeGreaterThanOrEqual(30_000n)
  })

  test('Arbitrum ERC-20 uses the sequencer estimate, not the fixed 100k', async () => {
    let estimateReq: any
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body))
      expect(req.method).toBe('eth_estimateGas')
      estimateReq = req.params[0]
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x7a120' })) // 500k
    }) as typeof fetch

    const result = await buildEvmTx(pioneerWithBalance('1'), arbitrum, {
      to: toAddress, amount: '5', fromAddress,
      caip: `eip155:42161/erc20:${tokenAddress}`, tokenDecimals: 6,
    })

    expect(estimateReq.to).toBe(tokenAddress)
    expect(estimateReq.data).toBe(result.data)
    expect(BigInt(result.gasLimit)).toBe(600_000n) // 500k + 20% buffer
  })

  test('ERC-20 gas never drops below the 100k floor', async () => {
    const result = await buildEvmTx(pioneerWithBalance('1'), arbitrum, {
      to: toAddress, amount: '5', fromAddress,
      caip: `eip155:42161/erc20:${tokenAddress}`, tokenDecimals: 6,
    })
    expect(BigInt(result.gasLimit)).toBe(100_000n)
  })
})
