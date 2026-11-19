/** Actual AssetPage: which chains let the receive view edit the derivation path. */
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'getComputedStyle', 'localStorage']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(window as any).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
const { act } = React
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: async (method: string) => {
    if (method === 'getAppSettings') return { zcashPrivacyEnabled: false, moneroEnabled: false, btcMultisigEnabled: false }
    if (method === 'getSwappableChainIds') return []
    if (method === 'getTokenVisibilityMap') return {}
    if (method === 'getActivityScanState') return { running: false }
    return new Promise(() => {})
  },
  onRpcMessage: () => () => {},
}))
mock.module('../../src/mainview/hooks/useBtcMultisigEnabled', () => ({ useBtcMultisigEnabled: () => false }))
mock.module('../../src/mainview/hooks/useRecentActivity', () => ({ useRecentActivity: () => ({ activities: [], loading: false }) }))
mock.module('../../src/mainview/components/ReceiveView', () => ({ ReceiveView: ({ pathEditable = true }: any) =>
  <div data-receive-path-editable={String(pathEditable)} /> }))
mock.module('../../src/mainview/components/SendForm', () => ({ SendForm: () => <div /> }))
mock.module('../../src/mainview/components/AnimatedUsd', () => ({ AnimatedUsd: ({ value }: any) => <span>{value}</span> }))
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
await import('../../src/mainview/i18n')
const { CHAINS } = await import('../../src/shared/chains')
const { AssetPage } = await import('../../src/mainview/components/AssetPage')
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }) }
const editable = async (chainId: string) => {
  const chain = CHAINS.find(c => c.id === chainId)!
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = createRoot(container)
  const balance = { chainId, address: '', balance: '0', balanceUsd: 0, tokens: [], symbol: chain.symbol }
  await act(async () => root.render(<ChakraProvider value={defaultSystem}><AssetPage chain={chain} balance={balance as any} onBack={() => {}} firmwareVersion="7.17.0" /></ChakraProvider>))
  await settle()
  const value = container.querySelector('[data-receive-path-editable]')?.getAttribute('data-receive-path-editable') ?? null
  await act(async () => root.unmount()); container.remove()
  return value
}
const result: any = {}
try {
  result.bitcoin = await editable('bitcoin')
  result.litecoin = await editable('litecoin')
  result.ethereum = await editable('ethereum')
} finally { dom.window.close() }
console.log(JSON.stringify(result))
