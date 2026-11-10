/** Actual AssetPage and account hooks with deferred, synthetic RPC replies. */
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
const calls: string[] = []
const requests = new Map<string, Array<(value: any) => void>>()
const waitFor = (name: string) => new Promise(resolve => { if (!requests.has(name)) requests.set(name, []); requests.get(name)!.push(resolve) })
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: async (method: string) => {
    calls.push(method)
    if (method === 'getEvmAddresses' || method === 'getBtcAccounts') return waitFor(method)
    if (method === 'getAppSettings') return { zcashPrivacyEnabled: false, moneroEnabled: false, btcMultisigEnabled: false }
    if (method === 'getSwappableChainIds') return ['ethereum']
    if (method === 'getTokenVisibilityMap') return {}
    if (method === 'getActivityScanState') return { running: false }
    if (method === 'getCachedBalances') return null
    throw new Error(`Unexpected fixture RPC: ${method}`)
  },
  onRpcMessage: (name: string, callback: (value: any) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name)!.add(callback)
    return () => listeners.get(name)!.delete(callback)
  },
}))
mock.module('../../src/mainview/hooks/useBtcMultisigEnabled', () => ({ useBtcMultisigEnabled: () => false }))
mock.module('../../src/mainview/hooks/useRecentActivity', () => ({ useRecentActivity: () => ({ activities: [], loading: false }) }))
mock.module('../../src/mainview/components/ReceiveView', () => ({ ReceiveView: ({ address, loading }: any) =>
  <div data-receive-address={address || ''} data-receive-loading={String(loading)} /> }))
mock.module('../../src/mainview/components/SendForm', () => ({ SendForm: () => <div /> }))
mock.module('../../src/mainview/components/AnimatedUsd', () => ({ AnimatedUsd: ({ value }: any) => <span>{value}</span> }))
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
await import('../../src/mainview/i18n')
const { CHAINS } = await import('../../src/shared/chains')
const { AssetPage } = await import('../../src/mainview/components/AssetPage')
const { useBtcAccounts } = await import('../../src/mainview/hooks/useBtcAccounts')
const owner = '0x0000000000000000000000000000000000000002'
const savedOwner = '0x0000000000000000000000000000000000000001'
const eth = CHAINS.find(chain => chain.id === 'ethereum')!
const aggregate = { chainId: 'ethereum', address: savedOwner, balance: '999', balanceUsd: 999000, nativeBalanceUsd: 999000, tokens: [], symbol: 'ETH', syncState: 'confirmed' as const }
const accountSet = (balance = '2') => ({ selectedIndex: 1, totalBalanceUsd: 4000, addresses: [{ addressIndex: 1, address: owner,
  chainBalances: { ethereum: { balance, balanceUsd: 4000, nativeBalanceUsd: 4000, tokens: [], syncState: 'confirmed' } } }] })
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }) }
const push = async (name: string, value: any) => { await act(async () => { for (const callback of listeners.get(name) || []) callback(value) }); await settle() }
const respond = async (name: string, value: any) => { await act(async () => { const next = requests.get(name)?.shift(); if (!next) throw new Error(`Missing ${name} request`); next(value) }); await settle() }
const container = document.createElement('div'); document.body.appendChild(container)
let root = createRoot(container)
const render = async (node: any) => { await act(async () => root.render(<ChakraProvider value={defaultSystem}>{node}</ChakraProvider>)); await settle() }
const page = (extra: any = {}) => <AssetPage chain={eth} balance={aggregate} onBack={() => {}} firmwareVersion="7.17.0" {...extra} />
const receive = () => container.querySelector('[data-receive-address]')!
const text = () => container.textContent || ''
const count = (method: string) => calls.filter(call => call === method).length
const result: any = { owner, savedOwner }
try {
  await render(page())
  result.pending = { loading: receive().getAttribute('data-receive-loading') === 'true', address: receive().getAttribute('data-receive-address'), aggregateShown: text().includes('999'), status: !!container.querySelector('[data-asset-balance-loading]'), btcReads: count('getBtcAccounts') }
  await respond('getEvmAddresses', accountSet())
  result.loaded = { address: receive().getAttribute('data-receive-address'), loading: receive().getAttribute('data-receive-loading') === 'true', aggregateShown: text().includes('999'), amountShown: text().includes('2') }
  const view = receive()
  await push('evm-addresses-update', accountSet('2.5'))
  await render(page({ balanceLoading: true }))
  result.refresh = { sameView: receive() === view, address: receive().getAttribute('data-receive-address'), amountShown: text().includes('2.5'), status: !!container.querySelector('[data-asset-balance-loading]') }
  await push('evm-addresses-update', { ...accountSet(), selectedIndex: 99 })
  result.missingOwner = { address: receive().getAttribute('data-receive-address'), aggregateShown: text().includes('999') }
  await push('wallet-data-purged', {})
  result.purged = { address: receive().getAttribute('data-receive-address'), oldOwnerShown: text().includes(owner), aggregateShown: text().includes('999') }
  await act(async () => root.unmount()); root = createRoot(container)
  const evmReads = count('getEvmAddresses'), btcReads = count('getBtcAccounts')
  await render(page({ watchOnly: true }))
  result.watchOnly = { address: receive().getAttribute('data-receive-address'), additionalEvmReads: count('getEvmAddresses') - evmReads, additionalBtcReads: count('getBtcAccounts') - btcReads }
  await act(async () => root.unmount()); root = createRoot(container)
  let hook: ReturnType<typeof useBtcAccounts>
  function BtcHost({ enabled }: { enabled: boolean }) { hook = useBtcAccounts(enabled); return null }
  await render(<BtcHost enabled={false} />)
  result.btcDisabled = count('getBtcAccounts')
  await render(<BtcHost enabled />)
  await push('btc-accounts-update', { accounts: [{ accountIndex: 0 }], totalBalance: 'new-push', totalBalanceUsd: 1 })
  await respond('getBtcAccounts', { accounts: [], totalBalance: 'old-reply', totalBalanceUsd: 0 })
  result.btcPushWins = hook!.btcAccounts.totalBalance
  let pending!: Promise<void>
  await act(async () => { pending = hook!.refresh() })
  await render(<BtcHost enabled={false} />)
  await respond('getBtcAccounts', { accounts: [{ accountIndex: 99 }], totalBalance: 'retired', totalBalanceUsd: 1 })
  await pending
  result.btcRetired = { accounts: hook!.btcAccounts.accounts, loading: hook!.loading }
} finally { await act(async () => root.unmount()); container.remove(); dom.window.close() }
console.log(JSON.stringify(result))
