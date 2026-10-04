import { expect, test } from 'bun:test'
import { evmMaxFee, evmNativeValue } from './evmFeePreview'

test('legacy and EIP-1559 signing requests expose their maximum network fee', () => {
  expect(evmMaxFee({ gasLimit: '0x27100', gasPrice: '0x3b9aca00' }, 1)).toBe('0.00016 ETH')
  expect(evmMaxFee({ gasLimit: '21000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '100000000' }, 1)).toBe('0.000042 ETH')
  expect(evmMaxFee({ gasLimit: 'bad', gasPrice: '1000000000' }, 1)).toBeNull()
  expect(evmMaxFee({ gasLimit: '21000', gasPrice: '1000000000' }, 43114)).toBe('0.000021 AVAX')
  expect(evmMaxFee({ gasLimit: '21000', gasPrice: '1000000000' }, 8453)).toBe('0.000021 ETH')
})

test('native signing value is readable on Ethereum, Base and Avalanche', () => {
  expect(evmNativeValue('0x30927f74c9de0000', 1)).toBe('3.5 ETH')
  expect(evmNativeValue('0x69707ae16da8400', 8453)).toBe('0.47485673 ETH')
  expect(evmNativeValue('0', 43114)).toBe('0 AVAX')
  expect(evmNativeValue('not-a-number', 1)).toBeNull()
})

test('native unit comes from the shared chain table for every built-in EVM chain', () => {
  expect(evmNativeValue('1000000000000000000', 42161)).toBe('1 ETH')
  expect(evmNativeValue('1000000000000000000', 10)).toBe('1 ETH')
  expect(evmNativeValue('1000000000000000000', 56)).toBe('1 BNB')
  expect(evmNativeValue('1000000000000000000', 100)).toBe('1 xDAI')
  expect(evmNativeValue('1000000000000000000', 137)).toBe('1 MATIC')
  expect(evmNativeValue('1000000000000000000', 999999)).toBe('1 native coin')
})
