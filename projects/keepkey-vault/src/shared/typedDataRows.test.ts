import { expect, test } from 'bun:test'
import { typedDataRows, typedDataSpendAmounts } from './typedDataRows'
import { assessSigningRisk } from './clearsign-risk'
import type { EIP712DecodedInfo, SigningRequestInfo } from './types'

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const UNKNOWN = '0x1111111111111111111111111111111111111111'
const SPENDER = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD'
const MAX160 = ((1n << 160n) - 1n).toString()
const typed = (fields: any[], known = true): EIP712DecodedInfo => ({
  operationName: 'Permit2 (Batch)', primaryType: 'PermitBatch', isKnownType: known,
  domain: { name: 'Permit2', chainId: 1, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
  fields,
} as EIP712DecodedInfo)
const address = (label: string, raw: any) => ({ label, value: String(raw), format: 'address' as const, raw })
const amount = (label: string, raw: string) => ({ label, value: raw, format: 'amount' as const, raw })
const value = (d: EIP712DecodedInfo, label: string) => typedDataRows(d).find((r) => r.label === label)!.value
const risk = (d: EIP712DecodedInfo) => assessSigningRisk({
  method: '/eth/sign-typed-data', typedDataDecoded: d, firmwareVersion: '7.16.0',
} as SigningRequestInfo)!.reasons[0].text

test('a known token amount reads in whole units, a date as a date', () => {
  const d = typed([
    address('Token', USDC), amount('Amount', '1000000000'),
    { label: 'Expiration', value: '2030-01-01 00:00:00 UTC', format: 'datetime', raw: '1893456000' },
  ])
  expect(value(d, 'Amount')).toBe('1,000 USDC (raw: 1000000000)')
  expect(value(d, 'Expiration')).toBe('2030-01-01 00:00:00 UTC (1893456000)')
})

test('typed data with no descriptor is never converted, whatever its field names say', () => {
  // CoW Swap order: sells WETH for USDC. "Sell Amount" follows "Buy Token".
  const d = typed([address('Sell Token', WETH), address('Buy Token', USDC), amount('Sell Amount', '1000000000000000000'), amount('Fee Amount', '2000000000')], false)
  expect(value(d, 'Sell Amount')).toBe('1000000000000000000')
  expect(value(d, 'Fee Amount')).toBe('2000000000')
})

test('an amount only uses the token of its own entry; a missing or odd token leaves it raw', () => {
  const d = typed([
    address('[1] Token', USDC), amount('[1] Amount', '250000000'),
    amount('[2] Amount', '5000000'),
    address('[3] Token', 12345), amount('[3] Amount', '7'),
    address('[4] Token', UNKNOWN), amount('[4] Amount', '9'),
    amount('Starting Base Fee', '7'),
  ])
  expect(value(d, '[1] Amount')).toBe('250 USDC (raw: 250000000)')
  expect(value(d, '[2] Amount')).toBe('5000000')
  expect(value(d, '[3] Amount')).toBe('7')
  expect(value(d, '[4] Amount')).toBe('9')
  expect(value(d, 'Starting Base Fee')).toBe('7')
})

test('the risk line names what the spender can take, in every entry', () => {
  expect(risk(typed([address('[1] Token', USDC), amount('[1] Amount', '250000000'), address('Spender', SPENDER)])))
    .toContain('spend up to 250 USDC, now and later')
})

test('an unlimited later entry is not hidden by a small first one, however it is written', () => {
  // The signer trims and accepts 0X; an amount this code cannot read at all counts as unlimited.
  for (const max of [MAX160, '0x' + 'f'.repeat(64), ' ' + MAX160, '0X' + 'F'.repeat(40), 'lots']) {
    expect(risk(typed([
      address('[1] Token', USDC), amount('[1] Amount', '250000000'),
      address('[2] Token', USDC), amount('[2] Amount', max),
      address('Spender', SPENDER),
    ]))).toContain(max === 'lots' ? 'spend ALL of your tokens' : 'spend ALL of your USDC')
  }
})

test('an unlimited unnamed token is not hidden behind a named one', () => {
  expect(risk(typed([
    address('[1] Token', USDC), amount('[1] Amount', MAX160),
    address('[2] Token', UNKNOWN), amount('[2] Amount', MAX160),
    address('Spender', SPENDER),
  ]))).toContain('spend ALL of your tokens')
})

test('what the signer receives is not listed as spendable', () => {
  const d = typed([
    address('Token', USDC), amount('Maximum Amount', '1100000000'), address('Spender', SPENDER),
    address('Output 1 Token', USDC), amount('Output 1 Start Amount', '3000000000'), amount('Output 1 Min Amount', '2900000000'),
  ])
  expect(typedDataSpendAmounts(d).map((a) => a.text)).toEqual(['1,100 USDC'])
  expect(risk(d)).toContain('spend up to 1,100 USDC, now and later')
  expect(value(d, 'Output 1 Min Amount')).toBe('2,900 USDC (raw: 2900000000)')
})

test('a bounded Permit2 to a reviewed spender is not Danger; unlimited or unreviewed still warns louder', () => {
  const level = (fields: any[], recognizedSpender?: string) => assessSigningRisk({
    method: '/eth/sign-typed-data', typedDataDecoded: typed(fields), firmwareVersion: '7.16.0', recognizedSpender,
  } as SigningRequestInfo)!.level
  const bounded = [address('Token', USDC), amount('Amount', '1000000000'), address('Spender', SPENDER)]
  const unlimited = [address('Token', USDC), amount('Amount', MAX160), address('Spender', SPENDER)]
  expect(level(bounded, 'Uniswap Universal Router')).toBe('medium')
  expect(level(unlimited, 'Uniswap Universal Router')).toBe('high')
  expect(level(bounded)).toBe('high')
  expect(level(unlimited)).toBe('critical')
})
