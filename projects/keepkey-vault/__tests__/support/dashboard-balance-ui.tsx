// The actual Dashboard with synthetic RPC replies: no wallet, device or network.
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'getComputedStyle', 'localStorage']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(window as any).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).fetch = async () => { throw new Error('Network access is forbidden in this Dashboard fixture') }
const listeners = new Map<string, Set<(value: unknown) => void>>()
const calls: string[] = []
const balanceReads: unknown[] = []
const busy = 'KeepKey is busy with another request. Wait for it to finish, then try again.'
const row = { chainId: 'bitcoin', symbol: 'BTC', balance: '0.25', balanceUsd: 16250, nativeBalanceUsd: 16250, priceUsd: 65000, address: 'synthetic-public-address', tokens: [], syncState: 'confirmed', updatedAt: Date.now() - 60_000 }
let cached = true
let staleReasons: string[] = []
let enabledChains = ['bitcoin']
let pendingCache = false
let readError: Error | null = new Error(busy)
let staleReply = false
let holdCache = false
let finishCache: ((value: unknown) => void) | undefined
const realNow = Date.now
let clockOffset = 0
Date.now = () => realNow() + clockOffset
const { CHAINS } = await import('../../src/shared/chains')
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: async (method: string, params: unknown) => {
    calls.push(method)
    switch (method) {
      case 'getCachedBalances': return holdCache ? new Promise(resolve => { finishCache = resolve }) : cached ? { balances: [{ ...row, txPending: pendingCache }], updatedAt: Date.now() - 60000, staleReasons } : null
      case 'getBalances': balanceReads.push(params); if (readError) throw readError; return [{ ...row, syncState: staleReply ? 'stale' : 'confirmed', updatedAt: staleReply ? row.updatedAt : Date.now() }]
      case 'getAppSettings': return { disabledNetworks: CHAINS.filter(c => !enabledChains.includes(c.id)).map(c => c.id), passphraseIntroShown: true, zcashPrivacyEnabled: false, moneroEnabled: false, hiveEnabled: false }
      case 'getPendingSwaps': case 'getCustomChains': return []
      case 'getMarketData': return { data: [65000] }
      case 'getTokenVisibilityMap': return {}
      default: return {}
    }
  },
  onRpcMessage: (name: string, listener: (value: unknown) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name)!.add(listener)
    return () => listeners.get(name)!.delete(listener)
  },
}))
const btcAccounts = { accounts: [], selectedXpub: null }
const evmAddresses = { addresses: [], selectedIndex: 0 }
mock.module('../../src/mainview/hooks/useBtcAccounts', () => ({ useBtcAccounts: () => ({ btcAccounts, selectXpub() {} }) }))
mock.module('../../src/mainview/hooks/useEvmAddresses', () => ({ useEvmAddresses: () => ({ evmAddresses, selectIndex() {} }) }))
mock.module('../../src/mainview/hooks/useVaultPortfolios', () => ({ useVaultPortfolios: () => ({ portfolios: [], loading: false, error: null, reload: async () => {}, setIncluded: async () => {} }) }))
mock.module('../../src/mainview/lib/iconPreload', () => ({ preloadIcons() {} }))
mock.module('../../src/mainview/lib/iconColor', () => ({ useIconColor: () => '#eeeeee', extractDominantColor: async () => null }))
mock.module('../../src/mainview/lib/sounds', () => ({ playChaChing() {}, playSent() {}, playAttention() {}, playBark() {} }))
const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
await import('../../src/mainview/i18n')
const { Dashboard } = await import('../../src/mainview/components/Dashboard')
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }) }
const mount = async () => {
  container = document.createElement('div'); document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<ChakraProvider value={defaultSystem}><Dashboard firmwareVersion="7.17.0" /></ChakraProvider>) })
  await settle()
}
const unmount = async () => { await act(async () => root.unmount()); container.remove() }
const refresh = async () => {
  await act(async () => { window.dispatchEvent(new Event('keepkey-refresh-balances')) })
  await settle()
}
const text = () => container.textContent || ''
const outage = () => text().includes('Balance server unavailable')
const balance = () => text().includes('0.25') && text().includes('16,250')
const refreshing = () => !!container.querySelector('[aria-label="Refreshing balance"]') || text().includes('Refreshing...')
const age = () => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Refresh Balances'))?.textContent
const push = async (payload: unknown) => {
  await act(async () => { for (const listener of listeners.get('pioneer-error') || []) listener(payload) })
}
const walletPush = async (name: string, payload: unknown) => {
  await act(async () => { for (const listener of listeners.get(name) || []) listener(payload) })
}
const releaseCache = async (cachedRow = row) => {
  await act(async () => { finishCache?.({ balances: [cachedRow], updatedAt: Date.now() - 60000 }) })
  await settle()
}

const result: Record<string, unknown> = {}
const notice = () => !!container.querySelector('[data-balance-error-notice]')
const refreshDue = () => container.querySelector('[data-balance-refresh-due]')?.getAttribute('data-balance-refresh-due') === 'true'
const fault = { severity: 'warning', degradedChains: ['BTC'], degradedChainIds: ['bitcoin'], staleChains: [], staleChainIds: [], checkedChainIds: ['bitcoin'], unresolvedFaultCount: 0, unresolvedErrorCount: 0, fullSnapshot: true }
try {
  readError = null
  await mount()
  result.freshCache = { refreshes: calls.filter(method => method === 'getBalances').length, notice: notice(), pulse: refreshDue() }
  await push({ severity: 'warning', staleChains: ['BTC'], staleChainIds: ['bitcoin'], staleMinutes: 0, checkedChainIds: ['bitcoin'], fullSnapshot: true, unresolvedFaultCount: 1, unresolvedErrorCount: 0 })
  result.ordinaryStaleQuiet = !notice() && !text().includes('Some balances last synced')
  clockOffset = 6 * 60_000
  await act(async () => window.dispatchEvent(new Event('focus')))
  await settle()
  result.focusQuiet = calls.filter(method => method === 'getBalances').length === 0
  await push(fault)
  result.actualFailureVisible = notice()
  const dismiss = [...container.querySelectorAll('button')].find(button => button.textContent === 'Dismiss')
  if (!dismiss) throw new Error('Missing error dismissal')
  await act(async () => dismiss.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
  await push(fault)
  result.sameErrorStaysDismissed = !notice()
  await push({ severity: 'warning', degradedChains: ['unmapped-network'], degradedChainIds: [], staleChains: [], staleChainIds: [], checkedChainIds: [], unresolvedFaultCount: 1, unresolvedErrorCount: 1 })
  result.newErrorReopens = notice()
  await push({ severity: 'none', checkedChainIds: ['bitcoin'] })
  result.partialRecoveryKeepsUnknownError = notice()
  await push({ severity: 'none', checkedChainIds: ['bitcoin'], fullSnapshot: true })
  result.fullRecoveryClears = !notice()
  await push(fault)
  await walletPush('balance-updated', { ...row, syncState: 'confirmed', updatedAt: Date.now() })
  result.chainRecoveryClears = !notice()
  await walletPush('balance-stale', { chainId: 'bitcoin' })
  result.transactionIsQuietGlobally = !notice()
  await act(async () => window.dispatchEvent(new Event('focus')))
  await settle()
  result.transactionCanRefresh = calls.filter(method => method === 'getBalances').length === 1
  await push(fault)
  readError = new Error(busy)
  await walletPush('wallet-data-purged', { reason: 'public-fixture-wallet-switch' })
  await settle()
  result.purgeReset = { notice: notice(), retainedBalance: balance(), pulse: refreshDue() }
  await unmount()
  const beforeMissing = balanceReads.length
  staleReasons = ['missing_chains:ethereum']
  enabledChains = ['bitcoin', 'ethereum']
  clockOffset = 0
  readError = null
  await mount()
  result.missingStructureQuiet = balanceReads.length === beforeMissing && !notice() && !refreshDue()
  await unmount()
  enabledChains = ['bitcoin']
  staleReasons = ['tx_after_cache:ethereum']
  await mount()
  result.transactionAfterCacheRefreshes = balanceReads.length === beforeMissing + 1 && (balanceReads.at(-1) as any)?.refreshReason === 'automatic'
  await unmount()
  staleReasons = []
  pendingCache = true
  await mount()
  result.pendingCacheRefreshes = balanceReads.length === beforeMissing + 2 && (balanceReads.at(-1) as any)?.refreshReason === 'automatic'
  await unmount()
  pendingCache = false
  clockOffset = 2 * 86_400_000
  readError = null
  staleReply = true
  await mount()
  result.oldCache = { pulse: refreshDue(), notice: notice(), duplicateCta: text().includes('Press to refresh balances') }
  result.oldCacheAutomatic = (balanceReads.at(-1) as any)?.refreshReason === 'automatic'
  staleReply = false
  await refresh()
  result.manualRefreshWorks = calls.filter(method => method === 'getBalances').length > 0 && !refreshDue()
  result.manualRefreshShowsAge = container.querySelector('[data-balance-refresh-due]')?.textContent?.includes('just now') ?? false
} finally {
  await unmount()
}
console.log('DASHBOARD_BALANCE_UI_RESULT ' + JSON.stringify(result))

