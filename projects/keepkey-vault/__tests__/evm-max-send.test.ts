import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { buildEvmTx } from '../src/bun/txbuilder/evm'
import { CHAINS } from '../src/shared/chains'
import { tokenMaxSpendableBaseUnits } from '../src/shared/max-send'
import { validateAddress } from '../src/shared/address-validation'

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

describe('ERC-20 max send', () => {
  const caip = `eip155:1/erc20:${tokenAddress}`
  // GetTokenBalance answers { data: "<formatted amount>" }; the client puts that
  // body under .data. Max with no positive frontend amount must read it.
  test('reads GetTokenBalance when the frontend has no positive amount', async () => {
    const pioneer = { ...pioneerWithBalance('1'), GetTokenBalance: async () => ({ data: { data: '17500.5' } }) }
    const result = await buildEvmTx(pioneer, ethereum, { to: toAddress, amount: '0', isMax: true, fromAddress, caip, tokenDecimals: 6, tokenBalance: '0' })
    // Max keeps the shared one-base-unit precision reserve.
    expect(BigInt('0x' + String(result.data).slice(-64))).toBe(tokenMaxSpendableBaseUnits('17500.5', 6)!)
  })

  test('refuses an error body instead of sending its placeholder zero', async () => {
    const pioneer = { ...pioneerWithBalance('1'), GetTokenBalance: async () => ({ data: { success: false, message: 'Invalid contract address format.', data: '0' } }) }
    await expect(buildEvmTx(pioneer, ethereum, { to: toAddress, amount: '0', isMax: true, fromAddress, caip, tokenDecimals: 6, tokenBalance: '0' }))
      .rejects.toThrow('Cannot fetch token balance for max send')
  })
})

describe('EVM max send', () => {
  test.each(['base', 'optimism', 'arbitrum'])('%s preserves a sub-gwei quote in signing and fee math', async (id) => {
    const chain = CHAINS.find(c => c.id === id)!
    const pioneer = {
      ...pioneerWithBalance('1'),
      GetGasPriceByNetwork: async () => ({ data: { average: '0.006' } }),
    }
    const result = await buildEvmTx(pioneer, chain, {
      to: toAddress, amount: '0', isMax: true, fromAddress,
    })
    expect(BigInt(result.gasPrice)).toBe(6_000_000n)
    const gasFee = BigInt(result.gasLimit) * 6_000_000n
    const gasReserve = (gasFee * 110n + 99n) / 100n
    expect(BigInt(result.value)).toBe(1_000_000_000_000_000_000n - gasReserve)
  })

  test.each(['base', 'optimism', 'arbitrum'])('%s slow preset never bids below the quoted price', async (id) => {
    const chain = CHAINS.find(c => c.id === id)!
    const pioneer = {
      ...pioneerWithBalance('1'),
      GetGasPriceByNetwork: async () => ({ data: { average: '0.006' } }),
    }
    const send = (feeLevel: number) => buildEvmTx(pioneer, chain, { to: toAddress, amount: '0.1', fromAddress, feeLevel })
    expect(BigInt((await send(1)).gasPrice)).toBe(6_000_000n)
    expect(BigInt((await send(10)).gasPrice)).toBe(9_000_000n)
  })

  test('slow preset still discounts above a configured chain minimum', async () => {
    const pioneer = { ...pioneerWithBalance('1'), GetGasPriceByNetwork: async () => ({ data: { average: '2' } }) }
    const result = await buildEvmTx(pioneer, ethereum, { to: toAddress, amount: '0.1', fromAddress, feeLevel: 1 })
    expect(BigInt(result.gasPrice)).toBe(1_600_000_000n)
  })

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

describe('EVM recipient', () => {
  const base = CHAINS.find(c => c.id === 'base')!
  // A pasted address keeps its spaces and validation trims them, so the build
  // must sign the trimmed address too; hdwallet refuses any other byte.
  test('builds the trimmed address the form validated', async () => {
    const native = await buildEvmTx(pioneerWithBalance('1'), base, { to: `  ${toAddress} `, amount: '0.001', fromAddress })
    expect(native.to).toBe(toAddress)
    const token = await buildEvmTx(pioneerWithBalance('1'), base, {
      to: ` ${toAddress} `, amount: '1', fromAddress, caip: `eip155:8453/erc20:${tokenAddress}`, tokenDecimals: 6, tokenBalance: '5',
    })
    expect(String(token.data).slice(10, 74)).toBe(toAddress.toLowerCase().slice(2).padStart(64, '0'))
  })

  test('refuses an ENS name or a malformed address before review', async () => {
    for (const to of ['vitalik.eth', `${toAddress}0`, '']) {
      await expect(buildEvmTx(pioneerWithBalance('1'), base, { to, amount: '0.001', fromAddress })).rejects.toThrow('Enter a full 0x recipient address')
    }
  })
})

describe('EVM address checksum (EIP-55)', () => {
  const base = CHAINS.find(c => c.id === 'base')!
  const valid = (a: string) => validateAddress(a, base)
  // Vectors from the EIP-55 specification, plus a real address in this wallet's address book.
  const vectors = ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb', '0x2A862D4a2852E3a29A5177d319e026adF2E7A073']

  test('accepts checksummed, all-lowercase and all-uppercase addresses', () => {
    for (const a of vectors) {
      expect(valid(a)).toEqual({ valid: true })
      expect(valid(a.toLowerCase())).toEqual({ valid: true })
      expect(valid('0x' + a.slice(2).toUpperCase())).toEqual({ valid: true })
      expect(valid(` ${a}\n`)).toEqual({ valid: true })
    }
  })

  test('refuses a mixed-case address whose checksum does not match', () => {
    const flipped = '0x2A862D4a2852E3a29A5177d319e026adf2E7A073' // one letter's case changed
    const typo = '0x2A862D4a2852E3a29A5177d319e026adF2E7A074' // last digit mistyped
    for (const a of [flipped, typo]) expect(valid(a)).toEqual({ valid: false, error: 'invalidEvmChecksum' })
  })

  test('the builder refuses it too, for callers that skip the form', async () => {
    await expect(buildEvmTx(pioneerWithBalance('1'), base, { to: '0x2A862D4a2852E3a29A5177d319e026adf2E7A073', amount: '0.001', fromAddress }))
      .rejects.toThrow('checksum mismatch')
    const ok = await buildEvmTx(pioneerWithBalance('1'), base, { to: vectors[4], amount: '0.001', fromAddress })
    expect(ok.to).toBe(vectors[4])
  })
})
