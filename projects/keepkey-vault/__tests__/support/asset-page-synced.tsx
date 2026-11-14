/** Actual AssetPage status chip for a cached vs confirmed balance; synthetic RPC replies only. */
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
const listeners = new Map<string, Set<(value: any) => void>>()
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: async (method: string) => {
    if (method === 'getAppSettings') return { zcashPrivacyEnabled: false, moneroEnabled: false, btcMultisigEnabled: false }
    if (method === 'getSwappableChainIds') return []
    if (method === 'getTokenVisibilityMap') return {}
    if (method === 'getActivityScanState') return { running: false }
    if (method === 'getEvmAddresses') return { selectedIndex: 0, totalBalanceUsd: 0, addresses: [] }
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
const thor = CHAINS.find(chain => chain.id === 'thorchain')!
const row = { chainId: 'thorchain', symbol: 'RUNE', balance: '12', balanceUsd: 20, nativeBalanceUsd: 20, address: 'thor1owner', tokens: [], updatedAt: Date.now() - 3600_000 }
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }) }
const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const chip = async (balance: any) => {
  await act(async () => root.render(<ChakraProvider value={defaultSystem}><AssetPage chain={thor} balance={balance} onBack={() => {}} firmwareVersion="7.17.0" /></ChakraProvider>))
  await settle()
  const text = container.textContent || ''
  return { synced: text.includes('Synced'), cached: text.includes('Cached') }
}
const result: Record<string, unknown> = {}
try {
  result.confirmed = await chip({ ...row, syncState: 'confirmed' })
  result.olderThanLastTx = await chip({ ...row, syncState: 'stale' })
} finally { await act(async () => root.unmount()); container.remove(); dom.window.close() }
console.log(JSON.stringify(result))
