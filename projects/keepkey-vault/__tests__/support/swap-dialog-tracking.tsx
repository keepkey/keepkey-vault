// The actual SwapDialog tracking view with synthetic RPC replies: no wallet, device or network.
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'getComputedStyle', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(window as any).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const txid = '0x' + 'e'.repeat(64)
const createdAt = Date.now() - 100_000
let refreshReply: () => Promise<unknown> = async () => { throw new Error('HTTP 503') }
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: async (method: string) => {
    switch (method) {
      case 'refreshSwap': return refreshReply()
      case 'getSwapAssets': case 'getBalances': case 'getCustomTokens': return []
      case 'getCachedBalances': return null
      case 'getSwapHealth': return { fetchedAt: Date.now(), integrations: [] }
      default: return {}
    }
  },
  rpcFire() {},
  onRpcMessage: () => () => {},
}))
mock.module('../../src/mainview/hooks/useEvmAddresses', () => ({ useEvmAddresses: () => ({ evmAddresses: { addresses: [], selectedIndex: 0 }, selectIndex() {} }) }))
mock.module('../../src/mainview/hooks/useDeviceState', () => ({ useDeviceState: () => ({ firmwareVersion: '7.17.0' }) }))
const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
await import('../../src/mainview/i18n')
const { SwapDialog } = await import('../../src/mainview/components/SwapDialog')
const resumeSwap: any = {
  txid, status: 'pending', confirmations: 0, createdAt, updatedAt: createdAt, estimatedTime: 600,
  fromChainId: 'ethereum', toChainId: 'bitcoin', fromAsset: 'ETH.ETH', toAsset: 'BTC.BTC', fromSymbol: 'ETH', toSymbol: 'BTC',
  fromCaip: 'eip155:1/slip44:60', toCaip: 'bip122:000000000019d6689c085ae165831e93/slip44:0',
  fromAmount: '0.1', expectedOutput: '0.004', minimumOutput: '0.0039', integration: 'thorchain',
  inboundAddress: '0x000000000000000000000000000000000000dEaD', memo: '=:BTC.BTC:bc1qfixture',
}
const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) }) }
const text = () => container.textContent || ''
const result: Record<string, unknown> = {}
try {
  // Like ActivityTracker and SwapTracker: mounted closed, opened by a resumed swap.
  const render = (swap: any) => root.render(<ChakraProvider value={defaultSystem}><SwapDialog open={!!swap} onClose={() => {}} resumeSwap={swap} /></ChakraProvider>)
  await act(async () => { render(null) })
  await settle()
  await act(async () => { render(resumeSwap) })
  await settle()
  result.elapsedFromBroadcast = /Elapsed 1:[45]\d/.test(text())
  result.remainingFromBroadcast = /Est\. time 8:[0-2]\d/.test(text())
  result.failedCheckShown = text().includes('Status check failed') && text().includes('Last checked')
  refreshReply = async () => ({ ...resumeSwap, status: 'confirming', confirmations: 1, statusCheck: { checkedAt: Date.now() } })
  const recheck = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Recheck'))
  await act(async () => { recheck?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
  result.recheckClearsFailure = !!recheck && !text().includes('Status check failed') && text().includes('Last checked')

} finally {
  await act(async () => root.unmount())
}
console.log('SWAP_DIALOG_TRACKING_RESULT ' + JSON.stringify(result))
