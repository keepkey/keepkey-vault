// Jasper audit v5 V3: a scanned amount shows in the field (not a stale USD figure), and
// EIP-681 value= is read as wei.
import { expect } from 'bun:test'
import { chainById, mount, unmount, setRecipient, setInput, press, query, click, lastBuild, input, scan } from './send-form-fixture'
const summary: Record<string, unknown> = {}

const bitcoin = chainById('bitcoin')
await mount({ chain: bitcoin, address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  balance: { chainId: 'bitcoin', balance: '1', balanceUsd: 100000, nativeBalanceUsd: 100000, address: 'x', syncState: 'confirmed' } })
await press(query('.kk-amount-flip')!)
await setInput('0.00', '10')
await scan('bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?amount=0.5')
// Back in crypto mode, showing what will be built.
expect(input('amountPlaceholder').value).toBe('0.5')
// Flipping to USD shows the scanned amount's value, not the $10 typed before.
await press(query('.kk-amount-flip')!)
expect(input('0.00').value).toBe('50000.00')
await click('buildTransaction')
expect(lastBuild()!.params).toMatchObject({ to: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', amount: '0.5' })
summary.usdMode = true
await unmount()

const ethereum = chainById('ethereum')
const owner = '0x' + '11'.repeat(20), to = '0x' + '33'.repeat(20)
const ethBalance = { chainId: 'ethereum', balance: '1', balanceUsd: 3000, nativeBalanceUsd: 3000, address: owner, syncState: 'confirmed' }
for (const [uri, expected] of [
  [`ethereum:${to}?value=10000000000000000`, '0.01'],
  [`ethereum:${to}@1?value=2.014e18`, '2.014'],
] as const) {
  await mount({ chain: ethereum, address: owner, balance: ethBalance })
  await scan(uri)
  expect(input('amountPlaceholder').value).toBe(expected)
  await click('buildTransaction')
  expect(lastBuild()!.params).toMatchObject({ to, amount: expected })
  await unmount()
}
summary.eip681Wei = true

// A token send ignores value= (it prices ETH, not the token); amount stays empty.
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
await mount({ chain: ethereum, address: owner, balance: ethBalance,
  token: { caip: `${ethereum.networkId}/erc20:${usdc}`, contractAddress: usdc, symbol: 'USDC', name: 'USD Coin', balance: '100', balanceUsd: 100, priceUsd: 1, decimals: 6 } })
await scan(`ethereum:${to}?value=10000000000000000`)
expect(input('amountPlaceholder').value).toBe('')
summary.tokenIgnoresValue = true
await unmount()

console.log(JSON.stringify(summary))
