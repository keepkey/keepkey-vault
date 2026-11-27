import { describe, expect, test } from 'bun:test'
import { deviceAmountText } from '../src/shared/device-amount'

const btc = { chainFamily: 'utxo', decimals: 8, isToken: false, symbol: 'BTC' }
const eth = { chainFamily: 'evm', decimals: 18, isToken: false, symbol: 'ETH' }

describe('the amount as the KeepKey prints it (firmware 378cf30)', () => {
  test('UTXO: coin_amnt_to_str, 8 decimals, trailing zeros dropped, ".0" when whole', () => {
    expect(deviceAmountText('0.12345678', btc)).toBe('0.12345678 BTC')
    expect(deviceAmountText('0.00050000', btc)).toBe('0.0005 BTC')
    expect(deviceAmountText('1', btc)).toBe('1.0 BTC')
    expect(deviceAmountText('90071992.54740993', btc)).toBe('90071992.54740993 BTC')
  })
  test('EVM native: ethereumFormatAmount, all 18 decimals, no rounding; Wei below 1 gwei', () => {
    expect(deviceAmountText('0.119948700000000001', eth)).toBe('0.119948700000000001 ETH')
    expect(deviceAmountText('1.5', eth)).toBe('1.5 ETH')
    expect(deviceAmountText('0.000000000999999999', eth)).toBe('999999999 Wei')
  })
  test('tokens and other chains: exact, token decimals, no trailing zeros', () => {
    expect(deviceAmountText('27.495919', { chainFamily: 'evm', decimals: 6, isToken: true, symbol: 'USDC' })).toBe('27.495919 USDC')
    expect(deviceAmountText('1.245000000', { chainFamily: 'ton', decimals: 9, isToken: false, symbol: 'TON' })).toBe('1.245 TON')
    expect(deviceAmountText('abc', btc)).toBeNull()
  })
})
