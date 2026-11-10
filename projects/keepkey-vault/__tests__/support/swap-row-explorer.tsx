// Render the actual activity row; clicks stay in a local RPC recorder.
// There is no backend, device, network access, or wallet/user-data storage.
import { JSDOM } from 'jsdom'
import { expect, mock } from 'bun:test'
import * as React from 'react'
import type { PendingSwap } from '../../src/shared/types'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const element = (tag: string) => ({ as, children, ...props }: any) => {
  const attrs = Object.fromEntries(Object.entries(props).filter(([key]) => /^(on[A-Z]|aria-|data-)/.test(key)
    || ['disabled', 'title', 'role', 'type', 'src', 'alt'].includes(key)))
  return React.createElement(as || tag, attrs, children)
}
mock.module('@chakra-ui/react', () => ({ Box: element('div'), Flex: element('div'), Text: element('span'),
  VStack: element('div'), HStack: element('div'), Image: element('img') }))
mock.module('../../src/mainview/i18n', () => ({ default: { resolvedLanguage: 'en', language: 'en' } }))
mock.module('../../src/mainview/i18n/ui', () => ({ useUiTranslation: () => (text: string) => text }))
mock.module('../../src/mainview/lib/number-locale', () => ({ getNumberLocale: () => 'en-US' }))
mock.module('../../src/mainview/components/DocsLink', () => ({ DocsLink: () => null }))
mock.module('../../src/shared/assetLookup', () => ({ caipToIcon: () => '' }))
const calls: Array<{ method: string; params: unknown }> = []
mock.module('../../src/mainview/lib/rpc', () => ({ rpcRequest: async (method: string, params: unknown) => {
  if (method !== 'openUrl') throw new Error(`Unexpected RPC: ${method}`)
  calls.push({ method, params })
} }))
globalThis.fetch = (() => { throw new Error('Network forbidden in swap explorer fixture') }) as typeof fetch

const { act } = React
const { createRoot } = await import('react-dom/client')
const { SwapRow } = await import('../../src/mainview/components/ActivityPanel')
const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const hash = 'a'.repeat(64)
const baseSwap: PendingSwap = {
  txid: hash, fromAsset: 'BASE.ETH', toAsset: 'ETH.ETH', fromSymbol: 'ETH', toSymbol: 'ETH',
  fromChainId: 'base', toChainId: 'ethereum', fromAmount: '1', expectedOutput: '0.99',
  memo: '', inboundAddress: '', integration: 'thorchain', status: 'pending', confirmations: 0,
  createdAt: Date.now(), updatedAt: Date.now(), estimatedTime: 60,
}
let selections = 0
const render = async (patch: Partial<PendingSwap>) => {
  calls.length = 0
  await act(async () => root.render(<SwapRow swap={{ ...baseSwap, ...patch }} onSelect={() => { selections++ }} />))
}
const explorer = () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Explorer')
const click = async (node: Element) => {
  await act(async () => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
}

// A ticker is display data: ETH spans networks and USDC is not a native chain.
// Assert the actual openUrl call, rather than only checking a helper result.
const correctNetworks = [
  { fromChainId: 'base', fromSymbol: 'ETH', host: 'basescan.org' },
  { fromChainId: 'arbitrum', fromSymbol: 'ETH', host: 'arbiscan.io' },
  { fromChainId: 'ethereum', fromSymbol: 'ETH', host: 'etherscan.io' },
  { fromChainId: 'base', fromSymbol: 'USDC', host: 'basescan.org' },
  { fromChainId: 'monad', fromSymbol: 'MON', host: 'monadscan.com' },
  { fromChainId: 'hyperliquid', fromSymbol: 'HYPE', host: 'hyperevmscan.io' },
  { fromChainId: 'tron', fromSymbol: 'USDT', host: 'tronscan.org', txid: hash.toUpperCase() },
]
for (const { host, ...swap } of correctNetworks) {
  await render(swap)
  expect(explorer()).toBeDefined()
  await click(explorer()!)
  const url = host === 'tronscan.org' ? `https://${host}/#/transaction/${hash}` : `https://${host}/tx/0x${hash}`
  expect(calls).toEqual([{ method: 'openUrl', params: { url } }])
  expect(selections).toBe(0) // Explorer must not also reopen the swap dialog.
}

// Old/invalid identity fields must not borrow Ethereum merely because the
// displayed token is ETH. Stored swap IDs are Vault IDs, not tickers or CAIPs.
const unavailableIdentities = [
  { fromChainId: 'not-a-known-chain', fromSymbol: 'ETH' },
  { fromChainId: '', fromSymbol: 'ETH' },
  { fromChainId: undefined, fromSymbol: 'ETH' },
  { fromChainId: 'ETH', fromSymbol: 'ETH' },
  { fromChainId: 'eip155:8453', fromSymbol: 'ETH' },
]
for (const swap of unavailableIdentities) {
  await render(swap as Partial<PendingSwap>)
  expect(explorer()).toBeUndefined()
  expect(calls).toHaveLength(0)
}
await render({ txid: '' })
expect(explorer()).toBeUndefined()
expect(calls).toHaveLength(0)
await click(container.firstElementChild!)
expect(selections).toBe(1)
await act(async () => root.unmount()); container.remove(); dom.window.close()
console.log(JSON.stringify({ correctNetworks: correctNetworks.length, unavailableIdentities: unavailableIdentities.length, rowSelection: true }))
