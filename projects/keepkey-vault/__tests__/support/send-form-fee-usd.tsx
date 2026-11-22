// Jasper audit v6 B13: the review read buildResult.feeUsd, which nothing set, so
// the fee never showed in USD. It is now priced in the form from the native price.
import { expect } from 'bun:test'
import { chainById, mount, unmount, setRecipient, setInput, click, lastBuild, complete, text } from './send-form-fixture'

const eth = chainById('ethereum')
const owner = '0x' + '11'.repeat(20)
const to = '0x' + '33'.repeat(20)
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const summary: Record<string, unknown> = {}

// 10 ETH worth $30,000: $3,000 per ETH.
const ethBalance = (usd: number) => ({ chainId: 'ethereum', balance: '10', balanceUsd: usd, nativeBalanceUsd: usd, address: owner, syncState: 'confirmed' })

// The fixture's fmtCompact is String, so a USD figure renders bare ("0.63").
// Return the review's fee row: native fee, then the USD label if any.
async function review(opts: { usd: number; fee: string; token?: any; amount: string }): Promise<string> {
  await mount({ chain: eth, address: owner, balance: ethBalance(opts.usd), ...(opts.token ? { token: opts.token } : {}) })
  await setRecipient(to)
  await setInput('amountPlaceholder', opts.amount)
  await click('buildTransaction')
  await complete(lastBuild()!, { fee: opts.fee, unsignedTx: {} })
  const row = text().match(/fee(.*?)showPayload/)?.[1]
  await unmount()
  expect(row).toBeDefined()
  return row!
}

// 0.00021 ETH at $3,000.
const native = await review({ usd: 30_000, fee: '0.00021', amount: '1' })
expect(native).toBe('0.00021 ETH0.63')
summary.native = native

// An L2-sized fee: shown as under a cent, never as "$0.00".
const tiny = await review({ usd: 30_000, fee: '1.3e-7', amount: '1' })
expect(tiny).toBe('1.3e-7 ETH<0.01') // the fixture's formatBalance is String too
summary.subCent = tiny

// No native price: no USD figure at all, rather than a "$0" fee.
const unpriced = await review({ usd: 0, fee: '0.00021', amount: '1' })
expect(unpriced).toBe('0.00021 ETH')
summary.unpriced = unpriced

// An ERC-20 send pays its fee in ETH: priced at ETH's $3,000, not USDC's $1.
const token = await review({
  usd: 30_000, fee: '0.00021', amount: '10',
  token: { caip: `${eth.networkId}/erc20:${usdc}`, contractAddress: usdc, symbol: 'USDC', name: 'USD Coin', balance: '100', balanceUsd: 99.97, priceUsd: 0.9997, decimals: 6 },
})
expect(token).toBe('0.00021 ETH0.63')
summary.token = token

console.log(JSON.stringify(summary))
