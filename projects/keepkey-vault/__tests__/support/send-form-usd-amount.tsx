// Jasper audit v5 V2: an amount typed in USD converts to at most the asset's decimals.
import { expect } from 'bun:test'
import { chainById, mount, unmount, setRecipient, setInput, press, query, click, lastBuild, text } from './send-form-fixture'
const { truncateDecimals } = await import('../../src/shared/locale')
const decimalsOf = (amount: string) => amount.split('.')[1]?.length ?? 0
const summary: Record<string, unknown> = {}

expect(truncateDecimals('0.00012676547', 8)).toBe('0.00012676')
expect(truncateDecimals('10.0030009', 6)).toBe('10.003')
expect(truncateDecimals('1.9999999', 0)).toBe('1')
expect(truncateDecimals('2.50', 6)).toBe('2.5')
summary.truncate = true

// BTC at $97,345.12: $12.34 used to become 0.00012676547 (11 decimals) and Build refused it.
const bitcoin = chainById('bitcoin')
await mount({ chain: bitcoin, address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  balance: { chainId: 'bitcoin', balance: '1', balanceUsd: 97345.12, nativeBalanceUsd: 97345.12, address: 'x', syncState: 'confirmed' } })
await setRecipient('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')
await press(query('.kk-amount-flip')!)
await setInput('0.00', '12.34')
await click('buildTransaction')
expect(text()).not.toContain('tooManyDecimals')
expect(lastBuild()!.params.amount).toBe('0.00012676')
summary.btc = lastBuild()!.params.amount
await unmount()

// USDC (6 decimals) at $0.9997: $10 used to become 10.0030009 (7 decimals).
const ethereum = chainById('ethereum')
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
await mount({ chain: ethereum, address: '0x' + '11'.repeat(20),
  balance: { chainId: 'ethereum', balance: '1', balanceUsd: 3000, nativeBalanceUsd: 3000, address: 'x', syncState: 'confirmed' },
  token: { caip: `${ethereum.networkId}/erc20:${usdc}`, contractAddress: usdc, symbol: 'USDC', name: 'USD Coin', balance: '100', balanceUsd: 99.97, priceUsd: 0.9997, decimals: 6 } })
await setRecipient('0x' + '33'.repeat(20))
await press(query('.kk-amount-flip')!)
await setInput('0.00', '10')
await click('buildTransaction')
expect(text()).not.toContain('tooManyDecimals')
expect(decimalsOf(lastBuild()!.params.amount)).toBeLessThanOrEqual(6)
summary.usdc = lastBuild()!.params.amount
await unmount()

console.log(JSON.stringify(summary))
