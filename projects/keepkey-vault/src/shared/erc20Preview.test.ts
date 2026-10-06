import { expect, test } from 'bun:test'
import { erc20Preview } from './erc20Preview'

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const spender = '0x1111111111111111111111111111111111111111'
const addressWord = `${'0'.repeat(24)}${spender.slice(2)}`
const approval = `0x095ea7b3${addressWord}${(1_000_000n * 1_000_000n).toString(16).padStart(64, '0')}`

test('a swap claim cannot hide a million-USDC allowance', () => {
  expect(erc20Preview(USDC, 1, approval)).toMatchObject({
    summary: `Allow ${spender} to spend up to 1,000,000 USDC`,
    amount: '1,000,000 USDC',
    rawAmount: '1000000000000',
  })
})

test('wrong chain or malformed calldata never inherits USDC units', () => {
  expect(erc20Preview(USDC, 8453, approval)?.amount).toContain('decimals unknown')
  expect(erc20Preview(USDC, 1, `${approval}00`)).toBeNull()
  expect(erc20Preview(USDC, 1, `0x095ea7b3${'f'.repeat(24)}${approval.slice(34)}`)).toBeNull()
})

test('Arbitrum USDT approval shows token and spender identities alongside exact addresses', () => {
  const token = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'
  const permit2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
  const data = `0x095ea7b3${permit2.slice(2).padStart(64, '0')}${'ff'.repeat(32)}`
  expect(erc20Preview(token, 42161, data)).toMatchObject({
    tokenAddress: token, tokenIdentity: 'USDT', counterpartyAddress: permit2,
    counterpartyIdentity: 'Uniswap Permit2', counterpartyLabel: 'Spender', amount: 'Unlimited USDT',
  })
  expect(erc20Preview(token, 999999, data)?.counterpartyIdentity).toBeUndefined()
  expect(erc20Preview(token, 999999, data)?.tokenIdentity).toBeUndefined()
})
