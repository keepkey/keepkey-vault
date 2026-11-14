import { describe, expect, test } from 'bun:test'
import { parseUnits, checkCustomGasPrice, buildEvmTx } from './evm'
import { CHAINS } from '../../shared/chains'
import { describeGasPriceError, GAS_PRICE_ERROR, networkGasPriceGwei } from '../../shared/gas-price-errors'
import { hasContractCode } from '../evm-rpc'

describe('parseUnits', () => {
  test('rejects more decimals than the asset has (H6)', () => {
    expect(() => parseUnits('0.0000000000000000001', 18)).toThrow(/decimal/)
  })
  test('exact decimals still parse', () => {
    expect(parseUnits('0.000000000000000001', 18)).toBe(1n)
    expect(parseUnits('1.5', 6)).toBe(1_500_000n)
  })
})

describe('checkCustomGasPrice (H1)', () => {
  const net = 6_000_000n // 0.006 gwei, Base
  test('20 gwei on Base is refused', () => expect(() => checkCustomGasPrice(20_000_000_000n, net)).toThrow(/10x/))
  test('0.000001 gwei is refused', () => expect(() => checkCustomGasPrice(1_000n, net)).toThrow(/base fee/))
  test('2x network is allowed', () => expect(() => checkCustomGasPrice(net * 2n, net)).not.toThrow())
  test('exactly 10x network is refused (H2)', () => expect(() => checkCustomGasPrice(net * 10n, net)).toThrow(/10x/))
})

describe('describeGasPriceError (H2: bound errors are translated)', () => {
  const t = (key: string, opts?: any) => `${key}|${opts?.gwei ?? ''}`
  const thrown = (fn: () => void) => { try { fn() } catch (e: any) { return e.message as string } return '' }
  test('maps each builder bound to a send-namespace key with the quote', () => {
    expect(describeGasPriceError(thrown(() => checkCustomGasPrice(20_000_000_000n, 6_000_000n)), t)).toBe('customGasPriceTooHigh|0.006')
    expect(describeGasPriceError(thrown(() => checkCustomGasPrice(1_000n, 6_000_000n)), t)).toBe('customGasPriceTooLow|0.006')
  })
  test('leaves unrelated errors alone', () => {
    expect(describeGasPriceError('Insufficient funds', t)).toBeNull()
  })
})

describe('networkGasPriceGwei (H2 placeholder)', () => {
  test('reads the average quote in every getFees shape', () => {
    expect(networkGasPriceGwei({ average: '0.006', fast: '0.007' })).toBe('0.006')
    expect(networkGasPriceGwei('25.123456')).toBe('25.1235')
    expect(networkGasPriceGwei({ fast: '3' })).toBe('3')
  })
  test('no quote is no number, never a guessed one', () => {
    for (const v of [undefined, null, {}, '0', 'abc', -1]) expect(networkGasPriceGwei(v)).toBeNull()
  })
  test('the quote-unavailable refusal is translated too', () => {
    const t = (key: string) => key
    expect(describeGasPriceError(`${GAS_PRICE_ERROR.quoteUnavailable}, so Desktop will not guess a fee.`, t)).toBe('gasPriceUnavailable')
  })
})

describe('hasContractCode (V7 contract recipient)', () => {
  test('deployed code is a contract', () => expect(hasContractCode('0x6080604052')).toBe(true))
  test('no code is a wallet', () => { for (const c of ['0x', '0x0', '', '0x00']) expect(hasContractCode(c)).toBe(false) })
  test('an EIP-7702 delegated account is still a wallet', () => {
    expect(hasContractCode('0xef0100' + '63c0c19a282a1b52b07dd5a65b58948a07dae32b')).toBe(false)
  })
})

describe('no gas quote, no transaction (H2: the 2 gwei guess is never signed)', () => {
  const base = CHAINS.find(c => c.id === 'base')!
  const to = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
  // Pioneer is never reached for a nonce or balance: the gas quote fails first.
  const failing = (gas: () => Promise<any>) => ({
    GetGasPriceByNetwork: gas,
    GetNonceByNetwork: async () => { throw new Error('nonce must not be asked for') },
  })
  const build = (pioneer: any, extra: Record<string, unknown> = {}) =>
    buildEvmTx(pioneer, base, { to, amount: '0.001', fromAddress: to, feeLevel: 5, ...extra } as any)
  test('a preset send refuses when Pioneer has no gas price', async () => {
    await expect(build(failing(async () => { throw new Error('timeout') }))).rejects.toThrow(GAS_PRICE_ERROR.quoteUnavailable)
    await expect(build(failing(async () => ({ data: { average: 'NaN' } })))).rejects.toThrow(GAS_PRICE_ERROR.quoteUnavailable)
    await expect(build(failing(async () => ({ data: '0' })), { feeLevel: 1 })).rejects.toThrow(GAS_PRICE_ERROR.quoteUnavailable)
  })
  test('a custom gas price refuses too: there is nothing to bound it with', async () => {
    await expect(build(failing(async () => { throw new Error('timeout') }), { gasPriceGwei: '20' })).rejects.toThrow(GAS_PRICE_ERROR.quoteUnavailable)
  })
})

describe('token Max is verified at send, never from the page cache', () => {
  const base = CHAINS.find(c => c.id === 'base')!
  const owner = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
  const usdc = 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  const pioneer = {
    GetGasPriceByNetwork: async () => ({ data: { average: '0.01' } }),
    GetNonceByNetwork: async () => ({ data: { nonce: 7 } }),
    GetBalanceAddressByNetwork: async () => ({ data: { balance: '0.01' } }),
    GetTokenBalance: async () => ({ data: '80.923336' }),
  }
  test('a stale cached balance on screen does not set the amount', async () => {
    const tx: any = await buildEvmTx(pioneer as any, base, {
      to: '0x0000000000000000000000000000000000001234', amount: '0', isMax: true, fromAddress: owner, feeLevel: 5,
      caip: usdc, tokenDecimals: 6, tokenBalance: '280.923336',
    } as any)
    // transfer(to, amount): the last 32 bytes are the amount in base units.
    expect(BigInt('0x' + tx.data.slice(-64))).toBe(80923335n) // 80.923336 on chain, less the 1-unit Max reserve
  })
  const send = (amount: string) => buildEvmTx(pioneer as any, base, {
    to: '0x0000000000000000000000000000000000001234', amount, fromAddress: owner, feeLevel: 5, caip: usdc, tokenDecimals: 6,
  } as any)
  test('a send above the balance read at send time is refused', async () => {
    await expect(send('100')).rejects.toThrow('Insufficient balance: 80.923336 available, 100 requested')
  })
  test('a send within it builds', async () => {
    const tx: any = await send('50')
    expect(BigInt('0x' + tx.data.slice(-64))).toBe(50000000n)
  })
})
