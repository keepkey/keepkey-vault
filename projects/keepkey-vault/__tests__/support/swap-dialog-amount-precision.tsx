// The real SwapDialog inputs with synthetic RPC replies. No network, signing or device.
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'getComputedStyle', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(window as any).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let networkAttempts = 0
;(globalThis as any).fetch = async () => { networkAttempts++; throw new Error('Network access is forbidden in this SwapDialog fixture') }

const { CHAINS } = await import('../../src/shared/chains')
const chain = CHAINS.find(row => row.id === 'zcash')!
const owner = '0x1111111111111111111111111111111111111111'
// Deliberately wrong provider precision: native ZEC must still use its chain's 8.
const zec = { asset: 'ZEC.ZEC', chainId: 'zcash', symbol: 'ZEC', name: 'Zcash', chainFamily: 'utxo', decimals: 18, caip: chain.caip }
const eth = { asset: 'ETH.ETH', chainId: 'ethereum', symbol: 'ETH', name: 'Ethereum', chainFamily: 'evm', decimals: 18, caip: 'eip155:1/slip44:60' }
let price = 123456
let balance = '1'
const balanceRow = () => ({ chainId: 'zcash', symbol: 'ZEC', balance, address: 'public-synthetic-zcash-address', nativeBalanceUsd: Number(balance) * price, balanceUsd: Number(balance) * price, tokens: [], syncState: 'confirmed', updatedAt: Date.now() })
const quotes: any[] = []
let forbiddenRpcCalls = 0
let state: any = null
const listeners: Record<string, ((message: any) => void) | undefined> = {}
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: async (method: string, params: any) => {
    switch (method) {
      case 'getSwapAssets': return [zec, eth]
      case 'getCachedBalances': return { balances: [balanceRow()], updatedAt: Date.now() }
      case 'getCustomTokens': return []
      case 'getSwapHealth': return { fetchedAt: Date.now(), integrations: [] }
      case 'getSwapQuote':
        quotes.push(params)
        return { quoteId: `synthetic-${quotes.length}`, expectedOutput: '0.00001', minimumOutput: '0.000009', inboundAddress: 'public-synthetic-vault', memo: '', fees: { affiliate: '0', outbound: '0', totalBps: 0 }, estimatedTime: 30, slippageBps: 100, integration: 'mayachain', swapper: 'mayachain' }
      case 'executeSwap': case 'previewSwapBuild': case 'getBalances': case 'btcGetAddress':
        forbiddenRpcCalls++
        throw new Error(`Unexpected RPC in amount-only fixture: ${method}`)
      default: return {}
    }
  },
  rpcFire(method: string, payload: any) { if (method === 'publishSwapUiState') state = payload },
  onRpcMessage(name: string, handler: (message: any) => void) {
    listeners[name] = handler
    return () => { if (listeners[name] === handler) listeners[name] = undefined }
  },
}))
const evm = { evmAddresses: { addresses: [{ addressIndex: 0, address: owner }], selectedIndex: 0, totalBalanceUsd: 0 }, initialLoaded: true, refresh: async () => {}, selectIndex() {} }
mock.module('../../src/mainview/hooks/useEvmAddresses', () => ({ useEvmAddresses: () => evm }))
mock.module('../../src/mainview/hooks/useDeviceState', () => ({ useDeviceState: () => ({ firmwareVersion: '7.17.0' }) }))

const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
await import('../../src/mainview/i18n')
const { SwapDialog } = await import('../../src/mainview/components/SwapDialog')
let container: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
const settle = async (ms = 25) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
const until = async (condition: () => boolean, label: string) => {
  for (const start = Date.now(); !condition();) {
    if (Date.now() - start > 5000) throw new Error(`Timed out waiting for ${label}; state=${JSON.stringify(state)}`)
    await settle()
  }
}
const mount = async () => {
  state = null
  container = document.createElement('div'); document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(<ChakraProvider value={defaultSystem}><SwapDialog open chain={chain} onClose={() => {}} /></ChakraProvider>) })
  await until(() => state?.fromAsset === zec.asset && state?.toAsset === eth.asset && !!state.amount, 'the automatic amount')
}
const unmount = async () => {
  if (!root) return
  await act(async () => root!.unmount())
  container!.remove(); root = null; container = null
}
const clickLabel = async (label: string) => {
  const button = [...container!.querySelectorAll('button')].find(node => node.textContent?.trim() === label)
  if (!button) throw new Error(`Missing ${label} button`)
  await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
  await settle()
}
const typeAmount = async (value: string) => {
  const field = container!.querySelector('input[inputmode="decimal"]') as HTMLInputElement | null
  if (!field) throw new Error('Missing amount input')
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await settle()
}
const payload = () => {
  const last = quotes.at(-1)
  return last && { fromCaip: last.fromCaip, toCaip: last.toCaip, amount: last.amount, isMax: last.isMax }
}

const result: Record<string, unknown> = {}
try {
  await mount()
  await until(() => quotes.length > 0, 'the $100 default quote')
  result.defaultQuote = payload()
  await unmount()

  price = 1234.56789
  const beforeUsd = quotes.length
  await mount()
  await clickLabel('$')
  await typeAmount('1')
  await until(() => quotes.length > beforeUsd, 'the actual USD-input quote')
  result.usdQuote = payload()
  result.usdInput = { inputMode: state.inputMode, fiatAmount: state.fiatAmount }
  await unmount()

  price = 100000
  balance = '0.123456789123'
  const beforeMax = quotes.length
  await mount()
  await clickLabel('MAX')
  await until(() => quotes.length > beforeMax, 'the actual MAX quote')
  result.maxQuote = payload()

  const beforeExcess = quotes.length
  await typeAmount('0.123456789')
  await settle(1000) // Beyond the real 800 ms quote debounce.
  result.explicitExcess = { rpcCalls: quotes.length - beforeExcess, invalid: container!.querySelector('input[inputmode="decimal"]')?.getAttribute('aria-invalid'), warning: container!.textContent?.includes('Too many decimal places: ZEC supports 8') ?? false }

  const beforeTrailingZero = quotes.length
  await typeAmount('0.1234567800')
  await until(() => quotes.length > beforeTrailingZero, 'the redundant-zero quote')
  result.trailingZeroQuote = payload()
  result.noSigningDeviceOrNetwork = forbiddenRpcCalls === 0 && networkAttempts === 0
} finally {
  await unmount()
}
console.log('SWAP_DIALOG_AMOUNT_PRECISION_RESULT ' + JSON.stringify(result))
