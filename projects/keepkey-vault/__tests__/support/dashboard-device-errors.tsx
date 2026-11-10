// The actual Dashboard with synthetic RPC replies: no wallet, device or network.
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'getComputedStyle', 'localStorage']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(window as any).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const listeners = new Map<string, Set<(value: unknown) => void>>()
const calls: string[] = []
const busy = 'KeepKey is busy with another request. Wait for it to finish, then try again.'
const row = { chainId: 'bitcoin', symbol: 'BTC', balance: '0.25', balanceUsd: 16250, nativeBalanceUsd: 16250, priceUsd: 65000, address: 'synthetic-public-address', tokens: [], syncState: 'confirmed' }
let cached = true
let readError: Error | null = new Error(busy)
let staleReply = false
let holdCache = false
let finishCache: ((value: unknown) => void) | undefined
const realNow = Date.now
let clockOffset = 0
Date.now = () => realNow() + clockOffset
const { CHAINS } = await import('../../src/shared/chains')
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: async (method: string) => {
    calls.push(method)
    switch (method) {
      case 'getCachedBalances': return holdCache ? new Promise(resolve => { finishCache = resolve }) : cached ? { balances: [row], updatedAt: Date.now() - 60000 } : null
      case 'getBalances': if (readError) throw readError; return [{ ...row, syncState: staleReply ? 'stale' : 'confirmed' }]
      case 'getAppSettings': return { disabledNetworks: CHAINS.filter(c => c.id !== 'bitcoin').map(c => c.id), passphraseIntroShown: true, zcashPrivacyEnabled: false, moneroEnabled: false, hiveEnabled: false }
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
try {
  await mount(); await refresh()
  result.cachedBusy = { outage: outage(), balance: balance(), refreshing: refreshing() }
  readError = new Error('KeepKey is locked. Unlock it before requesting new device data.')
  await refresh()
  result.cachedLocked = { outage: outage(), balance: balance(), refreshing: refreshing() }
  readError = new Error('Unlock KeepKey to load this account')
  await refresh()
  result.cachedCacheMiss = { outage: outage(), balance: balance(), refreshing: refreshing() }
  readError = new Error('Balance provider returned HTTP 503')
  await refresh()
  clockOffset = 300001
  await refresh()
  const previousAge = age()
  if (!previousAge?.includes('ago')) throw new Error('Expected a cached balance age before the stale fallback')
  readError = null; staleReply = true
  await refresh()
  result.staleFallback = { outage: outage(), balance: balance(), agePreserved: age() === previousAge }
  staleReply = false; clockOffset = 0
  await unmount()
  cached = false; readError = new Error(busy)
  await mount()
  result.coldBusy = { outage: outage(), hasUnknown: text().includes('—'), refreshing: refreshing() }
  await unmount()
  readError = new Error('Unlock KeepKey to load this account')
  await mount()
  result.coldCacheMiss = { outage: outage(), hasUnknown: text().includes('—'), refreshing: refreshing() }
  await unmount()
  readError = new Error('Balance provider returned HTTP 503')
  await mount()
  result.provider = { outage: outage(), message: text().includes(readError.message) }
  readError = new Error(busy); await refresh()
  result.providerAfterLocalFailure = outage()
  readError = null; await refresh()
  result.recovered = { outage: outage(), balance: balance() }
  await push({ severity: 'error', message: busy, url: 'synthetic-balance-server' })
  result.localPush = outage()

  await unmount(); holdCache = true; cached = true; readError = new Error(busy)
  await mount()
  await walletPush('balance-updated', { ...row, balance: '7', balanceUsd: 455000, nativeBalanceUsd: 455000 })
  result.pushBeforeCache = text().includes('7.0000 BTC')
  await releaseCache()
  result.newerPushSurvivesCache = text().includes('7.0000 BTC') && !text().includes('0.250000 BTC')

  await unmount(); await mount()
  await walletPush('balance-updated', { ...row, balance: '0', balanceUsd: 0, nativeBalanceUsd: 0 })
  await releaseCache()
  result.confirmedZeroSurvivesCache = text().includes('0 BTC') && !text().includes('0.250000 BTC')

  await unmount(); await mount(); readError = null
  await refresh()
  await releaseCache({ ...row, balance: '7', balanceUsd: 455000, nativeBalanceUsd: 455000 })
  result.completedReadSurvivesCache = text().includes('0.250000 BTC') && !text().includes('7.0000 BTC')
  readError = new Error(busy)

  await unmount(); await mount()
  await walletPush('wallet-data-purged', { reason: 'synthetic-wallet-switch' })
  await releaseCache()
  result.purgedCacheStaysEmpty = !text().includes('0.250000 BTC') && text().includes('—')
  result.deviceIntents = calls.filter(method => /unlock|pin|sign|broadcast/i.test(method))
} finally {
  await unmount()
}
console.log(JSON.stringify(result))
