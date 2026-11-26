// The real SwapDialog in the vault's default window (1200×800: the webview is
// shorter), driven through its swap-cmd channel with synthetic RPC replies —
// no wallet, device or network. jsdom has no layout, so this checks the
// structure the console's layout relies on.
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'getComputedStyle', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
const viewport = { width: 1200, height: 772 }
;(window as any).matchMedia = (query: string) => {
  const max = /max-height:\s*(\d+)px/.exec(query)
  return { matches: max ? viewport.height <= Number(max[1]) : false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const owner = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const ethEth = { asset: 'ETH.ETH', chainId: 'ethereum', symbol: 'ETH', name: 'Ethereum', chainFamily: 'evm', decimals: 18, caip: 'eip155:1/slip44:60' }
const baseEth = { asset: 'BASE.ETH', chainId: 'base', symbol: 'ETH', name: 'Ethereum', chainFamily: 'evm', decimals: 18, caip: 'eip155:8453/slip44:60' }
let serial = 0
let executeGate: Promise<any> | null = null
const quote = (params: any) => ({
  expectedOutput: '0.00995', minimumOutput: '0.0098', inboundAddress: '0x4cd00e387622c35bddb9b4c962c136462338bc31', memo: '',
  fees: { affiliate: '0', outbound: '0', totalBps: 0 }, estimatedTime: 30, slippageBps: 50,
  integration: 'near-intents', swapper: 'near-intents', executionMode: 'deposit',
  quoteId: `quote-${++serial}`, quoteCreatedAt: Date.now(), quoteExpiresAt: Date.now() + 60_000,
  risk: { tier: 'small', blocked: false, warning: false, requiresAcknowledgment: false, quoteMaxAgeMs: 60_000, allowancePct: 1 },
  toAddress: params.toAddress,
})
const calls: { method: string; params: any }[] = []
let state: any = null
const listeners: Record<string, ((message: any) => void) | undefined> = {}
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: async (method: string, params: any) => {
    calls.push({ method, params })
    switch (method) {
      case 'getSwapAssets': return [ethEth, baseEth]
      case 'getBalances': case 'getCustomTokens': return []
      case 'getCachedBalances': return null
      case 'getSwapHealth': return { fetchedAt: Date.now(), integrations: [] }
      case 'getSwapQuote': return quote(params)
      case 'previewSwapBuild': return { unsignedTx: { chainId: 1, to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', data: '0x', value: '0x2386f26fc10000', gasLimit: '0x5208', maxFeePerGas: '0x6fc23ac00', nonce: '0x1' } }
      case 'executeSwap': return executeGate ?? { txid: '0x' + 'e'.repeat(64) }
      case 'verifyTokenBalance': return { balance: '0.5' }
      default: return {}
    }
  },
  rpcFire(method: string, payload: any) { if (method === 'publishSwapUiState') state = payload },
  onRpcMessage: (name: string, handler: (message: any) => void) => { listeners[name] = handler; return () => { if (listeners[name] === handler) listeners[name] = undefined } },
}))
const evm = {
  evmAddresses: { addresses: [{ addressIndex: 0, address: owner, chainBalances: { ethereum: { chainId: 'ethereum', symbol: 'ETH', balance: '0.5', balanceUsd: 1500, address: owner } } }], selectedIndex: 0, totalBalanceUsd: 1500 },
  initialLoaded: true, refresh: async () => {}, selectIndex() {},
}
mock.module('../../src/mainview/hooks/useEvmAddresses', () => ({ useEvmAddresses: () => evm }))
mock.module('../../src/mainview/hooks/useDeviceState', () => ({ useDeviceState: () => ({ firmwareVersion: '7.17.0' }) }))

const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
await import('../../src/mainview/i18n')
const { SwapDialog } = await import('../../src/mainview/components/SwapDialog')

const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const settle = async (ms = 50) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
const until = async (condition: () => boolean, label: string, ms = 10_000) => {
  for (const started = Date.now(); !condition();) {
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${label}; phase=${state?.phase} error=${state?.error}`)
    await settle()
  }
}
const command = async (cmd: any) => { await act(async () => { listeners['swap-cmd']!(cmd) }); await settle() }
const panel = () => container.querySelector('[data-swap-panel]') as HTMLElement
const button = (pattern: RegExp) => [...container.querySelectorAll('button')].find(b => pattern.test((b.textContent || '').trim()))
/** Visible text: everything except what sits under "Technical details". */
const onScreen = () => {
  const copy = panel().cloneNode(true) as HTMLElement
  copy.querySelectorAll('details.kk-pf-tech').forEach(d => d.remove())
  return copy.textContent || ''
}
const pinned = (el: Element | undefined | null) => !!el && !el.closest('.kk-pf-scroll') && !!el.closest('.kk-pf-foot')
const result: Record<string, unknown> = {}
try {
  await act(async () => { root.render(<ChakraProvider value={defaultSystem}><SwapDialog open onClose={() => {}} /></ChakraProvider>) })
  await until(() => !!listeners['swap-cmd'], 'the swap command listener')
  await command({ kind: 'set', fromAssetDefinition: ethEth, fromAsset: ethEth.asset, toAssetDefinition: baseEth, toAsset: baseEth.asset, amount: '0.01', inputMode: 'crypto', useCustomAddress: false, customToAddress: '' })
  await until(() => !!state?.quote?.quoteId && state.phase === 'input', 'a quote')
  await settle(200)

  // ── Form ──
  const form = container.querySelector('[data-swap-form]')!
  result.formOneSurface = !!form && form.classList.contains('kk-pf') && container.querySelectorAll('.kk-pf').length === 1
    && !!form.querySelector(':scope > .kk-pf-left') && !!form.querySelector(':scope > .kk-pf-right') && !!form.querySelector(':scope > .kk-pf-pivot')
  const assets = [...container.querySelectorAll('[data-swap-asset]')].map(a => (a.querySelector('.kk-pf-pick')?.textContent || '').replace(/\s+/g, ' ').trim())
  result.formAssetsNamed = assets[0] === 'ETH · Ethereum' && assets[1] === 'ETH · Base'
  result.formNoIdsOnScreen = !/eip155:|slip44/.test(onScreen()) && !onScreen().includes(owner) && /eip155:1\/slip44:60/.test(panel().textContent || '')
  result.formNoNativeBadge = !/\bNATIVE\b|Ethereum · Ethereum/.test(onScreen())
  const slippage = [...container.querySelectorAll('.kk-pf-span .kk-pf-modes button')]
  result.formSlippageSegmented = slippage.length >= 4 && slippage.some(b => b.getAttribute('aria-pressed') === 'true')
  const review = button(/^Review swap$/)
  result.formReviewPillPinned = pinned(review) && review!.classList.contains('kk-pf-go') && !(review as HTMLButtonElement).disabled && !!review!.closest('.kk-pf-span')

  // ── Review (Confirm Quote) ──
  await act(async () => { review!.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await until(() => state?.phase === 'review' && !!container.querySelector('[data-trade-summary]') && !!state?.previewBuild?.unsignedTx, 'the review')
  await settle(150)
  const route = container.querySelector('[data-trade-route-map]')!
  const art = [...route.querySelectorAll('img')].find(img => /calculating/.test(img.getAttribute('src') || ''))
  result.reviewRouteArt = !!art && !!route.closest('.kk-pf-left')
  // No disc behind the end logos and no heavy ring around the art.
  result.reviewNoDiscs = !route.querySelector('circle[r="22"]') && !route.querySelector('circle[r="66"]')
  const amounts = container.querySelector('.kk-pf-amt.kk-pf-ends')
  result.reviewAmountLine = !!amounts && /0\.01 ETH/.test(amounts.textContent || '') && /0\.00995\d* ETH/.test(amounts.textContent || '') && /Base/.test(amounts.textContent || '')
  // The terms sit with the checklist, right above the decision.
  const terms = container.querySelector('.kk-pf-right dl.kk-pf-facts[data-trade-terms]')?.textContent || ''
  result.reviewTerms = /Minimum receive/.test(terms) && /Estimated swap cost/.test(terms) && /Estimated time/.test(terms) && terms.includes(owner)
  const checklist = container.querySelector('.kk-pf-right .kk-pf-list')?.textContent || ''
  result.reviewChecklist = /Received on your own account/.test(checklist) && /One confirmation on the device/.test(checklist)
  result.reviewNoIdsOnScreen = !/eip155:|slip44/.test(onScreen())
  const go = button(/^Swap on KeepKey$/), back = button(/^Back$/)
  result.reviewActionPinned = pinned(go) && pinned(back) && go!.getAttribute('aria-disabled') === 'false' && !container.querySelector('[data-swap-review] [style*="139,227,196"]')

  // ── Signing ──
  executeGate = new Promise(() => {}) // the device never answers in this run
  await act(async () => { go!.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await until(() => !!container.querySelector('[data-swap-signing]'), 'the signing screen')
  // Bun names the transaction the device signs now (a native deposit, EIP-1559).
  await act(async () => { listeners['swap-substage']?.({ stage: 'swap-signing', tx: { chainId: 1, to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', value: '0x2386f26fc10000', data: '0x', gasLimit: '0x5208', maxFeePerGas: '0x6fc23ac00', clearSign: false } }) }); await settle()
  const signing = container.querySelector('[data-swap-signing]')!
  // The firmware's own screens for this deposit (shared/eth-device-screens), following the device.
  const oled = () => [...signing.querySelectorAll('.kk-pf-left [data-oled-screen]')].map(el => [...el.children].map(c => c.textContent).join('|'))
  const first = oled()
  await act(async () => { listeners['device-button-request']?.({}) }); await settle()
  await act(async () => { listeners['device-button-request']?.({}) }); await settle()
  result.signingDeviceLeft = !!signing.querySelector('.kk-pf-left [data-device-mirror="exact"]')
    && first[0] === 'Send|Send 0.01 ETH to|0x4cD00E387622C35bDDB9b4c962C136462338|BC31'
    && oled()[0] === 'Transaction|Send 0.01 ETH from your wallet, paying up|to 0.00063 ETH for gas?'
  result.signingCancelPinned = pinned(container.querySelector('button[aria-label="Cancel"]'))
} catch (error: any) {
  result.error = error?.message || String(error)
} finally {
  await act(async () => root.unmount())
}
console.log('SWAP_PREFLIGHT_RESULT ' + JSON.stringify(result))
process.exit(0)
