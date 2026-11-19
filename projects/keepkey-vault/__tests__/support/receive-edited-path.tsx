/** Actual AssetPage: an account chain whose edited path can't be derived (device
 *  busy/locked) must not keep the saved default-path address in the QR. */
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
const { CHAINS } = await import('../../src/shared/chains')
const chain = CHAINS.find(c => c.id === 'cosmos')!
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: async (method: string) => {
    if (method === 'getAppSettings') return { zcashPrivacyEnabled: false, moneroEnabled: false, btcMultisigEnabled: false }
    if (method === 'getSwappableChainIds') return []
    if (method === 'getTokenVisibilityMap') return {}
    if (method === 'getActivityScanState') return { running: false }
    if (method === chain.rpcMethod) throw new Error('Device busy')
    return new Promise(() => {})
  },
  onRpcMessage: () => () => {},
}))
mock.module('../../src/mainview/hooks/useBtcMultisigEnabled', () => ({ useBtcMultisigEnabled: () => false }))
mock.module('../../src/mainview/hooks/useRecentActivity', () => ({ useRecentActivity: () => ({ activities: [], loading: false }) }))
let view: any = null
mock.module('../../src/mainview/components/ReceiveView', () => ({ ReceiveView: (props: any) => { view = props; return <div /> } }))
mock.module('../../src/mainview/components/SendForm', () => ({ SendForm: () => <div /> }))
mock.module('../../src/mainview/components/AnimatedUsd', () => ({ AnimatedUsd: ({ value }: any) => <span>{value}</span> }))
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
await import('../../src/mainview/i18n')
const { AssetPage } = await import('../../src/mainview/components/AssetPage')
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }) }
const snapshot = () => ({ address: view?.address ?? null, error: !!view?.error, path: view?.currentPath?.join('/') })

const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const balance = { chainId: chain.id, address: 'cosmos1savedaddress', balance: '0', balanceUsd: 0, tokens: [], symbol: chain.symbol }
const result: any = {}
try {
  await act(async () => root.render(<ChakraProvider value={defaultSystem}><AssetPage chain={chain} balance={balance as any} onBack={() => {}} firmwareVersion="7.17.0" /></ChakraProvider>))
  await settle()
  result.defaultPath = snapshot()
  const edited = [...chain.defaultPath.slice(0, -1), 5]
  await act(async () => { await view.onDerive(edited) })
  await settle()
  result.editedPath = { ...snapshot(), expectedPath: edited.join('/') }
  await act(async () => root.unmount())
} finally { container.remove(); dom.window.close() }
console.log(JSON.stringify(result))
