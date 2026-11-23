/** Actual AssetPage on BTC: balance syncs keep a picked receive address (audit v6 U2). */
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
const listeners = new Map<string, Set<(value: any) => void>>()
const requests = new Map<string, Array<(value: any) => void>>()
const waitFor = (name: string) => new Promise(resolve => { if (!requests.has(name)) requests.set(name, []); requests.get(name)!.push(resolve) })
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: async (method: string) => {
    if (method === 'getBtcAccounts' || method === 'getBtcAddressIndices') return waitFor(method)
    if (method === 'btcGetAddress') return 'bc1qfixture'
    if (method === 'getAppSettings') return { zcashPrivacyEnabled: false, moneroEnabled: false, btcMultisigEnabled: false }
    if (method === 'getSwappableChainIds') return []
    if (method === 'getTokenVisibilityMap') return {}
    if (method === 'getActivityScanState') return { running: false }
    return new Promise(() => {})
  },
  onRpcMessage: (name: string, callback: (value: any) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name)!.add(callback)
    return () => listeners.get(name)!.delete(callback)
  },
}))
let view: any = {}
mock.module('../../src/mainview/hooks/useBtcMultisigEnabled', () => ({ useBtcMultisigEnabled: () => false }))
mock.module('../../src/mainview/hooks/useRecentActivity', () => ({ useRecentActivity: () => ({ activities: [], loading: false }) }))
mock.module('../../src/mainview/components/ReceiveView', () => ({ ReceiveView: (props: any) => { view = props; return <div /> } }))
mock.module('../../src/mainview/components/SendForm', () => ({ SendForm: () => <div /> }))
mock.module('../../src/mainview/components/AnimatedUsd', () => ({ AnimatedUsd: ({ value }: any) => <span>{value}</span> }))
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
await import('../../src/mainview/i18n')
const { CHAINS } = await import('../../src/shared/chains')
const { AssetPage } = await import('../../src/mainview/components/AssetPage')
const btc = CHAINS.find(chain => chain.id === 'bitcoin')!
const account = (accountIndex: number) => ({ accountIndex, totalBalanceUsd: 0, xpubs: [{ scriptType: 'p2wpkh', xpub: `xpub-${accountIndex}` }] })
const accounts = (selected: number) => ({ accounts: [account(0), account(1)], totalBalanceUsd: 0, totalBalance: '0', selectedXpub: { accountIndex: selected, scriptType: 'p2wpkh' } })
const indices = (receiveIndex: number, changeIndex: number) => ({ receiveIndex, changeIndex, discoveryAvailable: true })
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }) }
const push = async (name: string, value: any) => { await act(async () => { for (const callback of listeners.get(name) || []) callback(value) }); await settle() }
const respond = async (name: string, value: any) => { await act(async () => { const next = requests.get(name)?.shift(); if (!next) throw new Error(`Missing ${name} request`); next(value) }); await settle() }
const run = async (fn: () => void) => { await act(async () => fn()); await settle() }
const sync = () => push('balance-updated', { chainId: 'bitcoin', syncState: 'confirmed' })
const pick = () => ({ change: view.btcChangeIndex, index: view.btcAddressIndex, limit: view.btcAddressIndexLimit })
const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const balance = { chainId: 'bitcoin', address: '', balance: '0', balanceUsd: 0, tokens: [], symbol: 'BTC' }
const result: any = {}
try {
  await act(async () => root.render(<ChakraProvider value={defaultSystem}><AssetPage chain={btc} balance={balance as any} onBack={() => {}} firmwareVersion="7.17.0" /></ChakraProvider>))
  await settle()
  await respond('getBtcAccounts', accounts(0))
  await respond('getBtcAddressIndices', indices(3, 1))
  result.opened = pick()
  await sync()
  result.followingWhileSyncing = { loading: view.loading }
  await respond('getBtcAddressIndices', indices(4, 1))
  result.untouchedAfterSync = pick()
  await run(() => view.onBtcAddressIndex(7))
  await sync()
  result.pickedWhileSyncing = { loading: view.loading }
  await respond('getBtcAddressIndices', indices(5, 1))
  result.pickedAfterSync = pick()
  await run(() => view.onBtcChangeIndex(1))
  result.changeBranch = pick()
  await sync()
  await respond('getBtcAddressIndices', indices(5, 2))
  result.changeAfterSync = pick()
  await run(() => view.onBtcAddressIndex(3))
  await run(() => view.onBtcAddressIndex(2))
  result.steppedBack = pick()
  await push('btc-accounts-update', accounts(1))
  await respond('getBtcAddressIndices', indices(9, 4))
  result.otherAccount = pick()
} finally { await act(async () => root.unmount()); container.remove(); dom.window.close() }
console.log(JSON.stringify(result))
