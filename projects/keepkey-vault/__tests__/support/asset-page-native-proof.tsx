/** Actual AssetPage native-coin header while the portfolio is degraded (audit v4 H7); synthetic RPC replies only. */
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'getComputedStyle', 'localStorage']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(window as any).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
globalThis.fetch = (() => { throw new Error('Network forbidden in asset page fixture') }) as typeof fetch
const React = await import('react')
const { act } = React
const owner = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
// Pioneer's portfolio is degraded: the owner's Base row cannot vouch for its ETH.
const degraded = { chainId: 'base', symbol: 'ETH', balance: '0', balanceUsd: 0, address: owner, tokens: [], syncState: 'degraded' }
let reads = 0
let ownerRow: any = degraded
const listeners = new Map<string, Set<(value: any) => void>>()
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: async (method: string) => {
    if (method === 'getAppSettings') return { zcashPrivacyEnabled: false, moneroEnabled: false, btcMultisigEnabled: false }
    if (method === 'getSwappableChainIds') return []
    if (method === 'getTokenVisibilityMap') return {}
    if (method === 'getActivityScanState') return { running: false }
    if (method === 'getEvmAddresses') return { selectedIndex: 0, totalBalanceUsd: 0, addresses: [{ addressIndex: 0, address: owner, chainBalances: { base: ownerRow } }] }
    // The on-chain native read (Pioneer EvmReadRpc in the real handler).
    if (method === 'verifyTokenBalance') { reads++; return { balance: '0.5' } }
    if (method === 'getBalance') return degraded
    return null
  },
  onRpcMessage: (name: string, callback: (value: any) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name)!.add(callback)
    return () => listeners.get(name)!.delete(callback)
  },
}))
mock.module('../../src/mainview/hooks/useBtcMultisigEnabled', () => ({ useBtcMultisigEnabled: () => false }))
mock.module('../../src/mainview/hooks/useRecentActivity', () => ({ useRecentActivity: () => ({ activities: [], loading: false }) }))
mock.module('../../src/mainview/components/ReceiveView', () => ({ ReceiveView: () => <div /> }))
mock.module('../../src/mainview/components/SendForm', () => ({ SendForm: () => <div /> }))
mock.module('../../src/mainview/components/AnimatedUsd', () => ({ AnimatedUsd: ({ value }: any) => <span>{value}</span> }))
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
await import('../../src/mainview/i18n')
const { CHAINS } = await import('../../src/shared/chains')
const { AssetPage } = await import('../../src/mainview/components/AssetPage')
const base = CHAINS.find(chain => chain.id === 'base')!
const settle = async (ms = 20) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const shows = () => { const text = container.textContent || ''; return { onChain: text.includes('0.5'), unverified: text.includes('—') } }
const push = async (name: string, value: any) => { await act(async () => { for (const cb of listeners.get(name) || []) cb(value) }); await settle() }
const result: Record<string, unknown> = {}
try {
  await act(async () => root.render(<ChakraProvider value={defaultSystem}><AssetPage chain={base} balance={degraded as any} onBack={() => {}} firmwareVersion="7.17.0" /></ChakraProvider>))
  await settle(100)
  result.firstRead = { reads, ...shows() }
  // Another degraded portfolio push for Base: the proof it dropped is read again.
  await push('balance-updated', degraded)
  await settle(50)
  result.afterDegradedPush = { reads, ...shows() }
  // A refresh that comes back degraded (handleRefresh throws) reads the chain again too.
  const refresh = Array.from(container.querySelectorAll('button')).find(b => /refresh/i.test(b.getAttribute('aria-label') || b.getAttribute('title') || ''))
  await act(async () => { refresh?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle(100)
  result.afterDegradedRefresh = { found: !!refresh, reads, ...shows() }
  await act(async () => root.unmount())

  // H18: after the price-only refresh the aggregate (sidebar) holds the new
  // price; the chain page must price the selected owner's ETH with it too.
  ownerRow = { chainId: 'base', symbol: 'ETH', balance: '0.001134', balanceUsd: 3.2, nativeBalanceUsd: 3.2, address: owner, tokens: [], syncState: 'confirmed' }
  const aggregate = { ...ownerRow, balanceUsd: 3.402, nativeBalanceUsd: 3.402 }
  const priced = createRoot(container)
  await act(async () => priced.render(<ChakraProvider value={defaultSystem}><AssetPage chain={base} balance={aggregate as any} onBack={() => {}} firmwareVersion="7.17.0" /></ChakraProvider>))
  await settle(100)
  const text = container.textContent || ''
  // The USD figure follows "ETH" (AnimatedUsd is a bare span here).
  result.repricedHeader = { sidebarPrice: text.includes('ETH3.402'), ownerOldPrice: text.replaceAll('ETH3.402', '').includes('ETH3.2') }
  await act(async () => priced.unmount())
} finally { container.remove(); dom.window.close() }
console.log(JSON.stringify(result))
