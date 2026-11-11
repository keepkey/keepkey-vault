import { describe, expect, test } from 'bun:test'
import { formatEvmFeePaid } from '../src/mainview/lib/evm-fee-display'

const BASE_ETH = 'eip155:8453/slip44:60'

describe('formatEvmFeePaid', () => {
  test('a total fee in wei (Jasper, Base swap) renders in ETH, not as gas', () => {
    // 37,773 gas x 0.05 gwei + 709,425,858 wei L1 fee
    expect(formatEvmFeePaid('1889359425858', undefined, BASE_ETH, 'en-US')).toBe('0.0000019 ETH')
  })
  test('gas units plus price render the fee and keep the gas detail', () => {
    expect(formatEvmFeePaid('37773', '50000000', BASE_ETH, 'en-US')).toBe('0.0000019 ETH · 37,773 gas · 0.05 gwei')
  })
  test('gas units without a price stay as gas', () => {
    expect(formatEvmFeePaid('37773', undefined, BASE_ETH, 'en-US')).toBe('37,773 gas')
  })
  test('uses the chain native symbol (Polygon -> POL), not the swapped token', () => {
    expect(formatEvmFeePaid('2000000000000000', undefined, 'eip155:137/erc20:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', 'en-US')).toBe('0.002 POL')
  })
  test('non-numeric input is shown as-is', () => {
    expect(formatEvmFeePaid('n/a', undefined, BASE_ETH, 'en-US')).toBe('n/a gas')
  })
})
