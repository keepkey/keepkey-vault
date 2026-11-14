import { describe, expect, test } from 'bun:test'
import { parseUnits, checkCustomGasPrice } from './evm'
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
    expect(describeGasPriceError(`${GAS_PRICE_ERROR.quoteUnavailable}, so a custom gas price cannot be checked.`, t)).toBe('customGasPriceUnavailable')
  })
})

describe('hasContractCode (V7 contract recipient)', () => {
  test('deployed code is a contract', () => expect(hasContractCode('0x6080604052')).toBe(true))
  test('no code is a wallet', () => { for (const c of ['0x', '0x0', '', '0x00']) expect(hasContractCode(c)).toBe(false) })
  test('an EIP-7702 delegated account is still a wallet', () => {
    expect(hasContractCode('0xef0100' + '63c0c19a282a1b52b07dd5a65b58948a07dae32b')).toBe(false)
  })
})
