import { describe, expect, test } from 'bun:test'
import { buildEvmTx } from '../src/bun/txbuilder/evm'
import { CHAINS } from '../src/shared/chains'

const ethereum = CHAINS.find(c => c.id === 'ethereum')!
const fromAddress = '0x000000000000000000000000000000000000bEEF'
const toAddress = '0x000000000000000000000000000000000000dEaD'
const tokenAddress = '0x000000000000000000000000000000000000c0fe'

const pioneerWithBalance = (balance: string) => ({
  GetGasPriceByNetwork: async () => ({ data: '1' }),
  GetNonceByNetwork: async () => ({ data: { nonce: 7 } }),
  GetBalanceAddressByNetwork: async () => ({ data: { balance } }),
})

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
})
