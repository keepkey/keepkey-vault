import { expect, test } from 'bun:test'
import { typedDataAmounts, typedDataRows } from './typedDataRows'
import { assessSigningRisk } from './clearsign-risk'
import type { EIP712DecodedInfo, SigningRequestInfo } from './types'

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
const SPENDER = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD'
const permit = (fields: EIP712DecodedInfo['fields']): EIP712DecodedInfo => ({
  operationName: 'Permit2 (Batch)', primaryType: 'PermitBatch', isKnownType: true,
  domain: { name: 'Permit2', chainId: 1, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
  fields,
} as EIP712DecodedInfo)
const address = (label: string, raw: string) => ({ label, value: raw, format: 'address' as const, raw })
const amount = (label: string, raw: string) => ({ label, value: raw, format: 'amount' as const, raw })

test('a known token amount reads in whole units, a date as a date', () => {
  const rows = typedDataRows(permit([
    address('Token', USDC), amount('Amount', '1000000000'),
    { label: 'Expiration', value: '2030-01-01 00:00:00 UTC', format: 'datetime', raw: '1893456000' },
  ]))
  expect(rows[1]).toEqual({ label: 'Amount', value: '1,000 USDC (raw: 1000000000)' })
  expect(rows[2]).toEqual({ label: 'Expiration', value: '2030-01-01 00:00:00 UTC (1893456000)' })
})

test('an unknown token stays raw and says so; a fee is never given a token', () => {
  const rows = typedDataRows(permit([
    address('Output 1 Token', '0x1111111111111111111111111111111111111111'), amount('Output 1 Start Amount', '5'),
    amount('Starting Base Fee', '7'),
  ]))
  expect(rows[1].value).toBe('5 raw token units (decimals unknown)')
  expect(rows[2].value).toBe('7')
})

test('each amount uses the token before it', () => {
  const amounts = typedDataAmounts(permit([
    address('[1] Token', USDC), amount('[1] Amount', '250000000'),
    address('[2] Token', DAI), amount('[2] Amount', ((1n << 160n) - 1n).toString()),
  ]))
  expect(amounts[0].text).toBe('250 USDC')
  expect(amounts[1].unlimited).toBe(true)
})

test('the risk line names every amount, and an unlimited later entry is not hidden by a small first one', () => {
  const risk = (fields: EIP712DecodedInfo['fields']) => assessSigningRisk({
    method: '/eth/sign-typed-data', typedDataDecoded: permit(fields), firmwareVersion: '7.16.0',
  } as SigningRequestInfo)!.reasons[0].text
  const bounded = risk([address('[1] Token', USDC), amount('[1] Amount', '250000000'), address('Spender', SPENDER)])
  expect(bounded).toContain('spend up to 250 USDC, now and later')
  const hidden = risk([
    address('[1] Token', USDC), amount('[1] Amount', '250000000'),
    address('[2] Token', USDC), amount('[2] Amount', ((1n << 160n) - 1n).toString()),
    address('Spender', SPENDER),
  ])
  expect(hidden).toContain('spend ALL of your USDC')
})
