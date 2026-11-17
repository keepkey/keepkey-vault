// Actual Dashboard and locale switching with synthetic zero balances. No
// wallet, device, signing or network access is allowed in this fixture.
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'getComputedStyle', 'localStorage']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(window as any).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).fetch = async () => { throw new Error('Network access is forbidden in the empty-balance fixture') }
const { CHAINS } = await import('../../src/shared/chains')
const calls: string[] = []
const balances = ['bitcoin', 'zcash'].map(chainId => ({ chainId, symbol: chainId === 'bitcoin' ? 'BTC' : 'ZEC', balance: '0', balanceUsd: 0, nativeBalanceUsd: 0, priceUsd: 0, address: 'synthetic-public-address', tokens: [], syncState: 'confirmed' }))
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: async (method: string) => {
    calls.push(method)
    if (/derive|unlock|pin|sign|broadcast/i.test(method)) throw new Error('Device access is forbidden in the empty-balance fixture')
    switch (method) {
      case 'getCachedBalances': return { balances, updatedAt: Date.now() }
      case 'getBalances': return balances
      case 'getAppSettings': return { disabledNetworks: CHAINS.filter(chain => !['bitcoin', 'zcash'].includes(chain.id)).map(chain => chain.id), passphraseIntroShown: true, zcashPrivacyEnabled: true, moneroEnabled: false, hiveEnabled: false }
      case 'getPendingSwaps': case 'getCustomChains': return []
      case 'getMarketData': return { data: [0] }
      case 'getTokenVisibilityMap': return {}
      default: return {}
    }
  },
  onRpcMessage: () => () => {},
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
const { default: i18n } = await import('../../src/mainview/i18n')
const { Dashboard } = await import('../../src/mainview/components/Dashboard')
await i18n.changeLanguage('pt')
const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const result: Record<string, unknown> = {}
const sentence = () => [...container.querySelectorAll('p')].map(element => element.textContent).find(text => text?.includes('saldo de ') || text?.includes(' balance yet'))
try {
  await act(async () => { root.render(<ChakraProvider value={defaultSystem}><Dashboard firmwareVersion="7.17.0" /></ChakraProvider>) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
  for (const symbol of ['BTC', 'ZEC']) {
    const button = [...container.querySelectorAll('button')].find(element => element.querySelector('img')?.getAttribute('alt') === symbol)
    if (!button) throw new Error('Missing dashboard chain button ' + symbol)
    await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    result[symbol] = sentence()
  }
  await act(async () => { await i18n.changeLanguage('en') })
  result.english = sentence()
  await act(async () => { await i18n.changeLanguage('pt') })
  result.portugueseAgain = sentence()
  result.deviceCalls = calls.filter(method => /derive|unlock|pin|sign|broadcast/i.test(method))
} finally {
  await act(async () => root.unmount())
  container.remove(); dom.window.close()
}
console.log('EMPTY_BALANCE_I18N_RESULT ' + JSON.stringify(result))
