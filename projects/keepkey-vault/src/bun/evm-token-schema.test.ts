import { expect, test } from 'bun:test'
import { buildTokenSchema, tokenCallShape } from './evm-token-schema'
import { buildEvmSchemaBody } from './evm-certified-schema'
const contract = '0x1111111111111111111111111111111111111111'
test('only canonical ERC-20 shapes and firmware-representable token identities compile', () => {
  for (const [selector, length] of [['0x095ea7b3', 68], ['0xa9059cbb', 68], ['0x23b872dd', 100]] as const) {
    expect(buildEvmSchemaBody(buildTokenSchema(42161, contract, selector, length, { symbol: 'USDT', decimals: 6 })).length).toBeGreaterThan(40)
    expect(tokenCallShape(42161, contract, selector, length + 1)).toBe(false)
  }
  for (const token of [{ symbol: 'USDT\nApprove', decimals: 6 }, { symbol: 'USDT', decimals: 37 }, { symbol: 'USDT', decimals: -1 }, { symbol: 'USDT', decimals: 6.5 }]) {
    expect(() => buildTokenSchema(42161, contract, '0x095ea7b3', 68, token)).toThrow()
  }
  expect(tokenCallShape(2 ** 32, contract, '0x095ea7b3', 68)).toBe(false)
})
