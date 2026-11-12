// The actual SwapDialog review → approve → swap path with synthetic RPC replies: no wallet, device or network.
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'getComputedStyle', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(window as any).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const BUSY = 'KeepKey is busy with another request. Wait for it to finish, then try again.'
const owner = '0x000000000000000000000000000000000000dEaD'
const token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const usdc = { asset: 'BASE.USDC', chainId: 'base', symbol: 'USDC', name: 'USD Coin', chainFamily: 'evm', decimals: 6, caip: `eip155:8453/erc20:${token}`, contractAddress: token }
const eth = { asset: 'BASE.ETH', chainId: 'base', symbol: 'ETH', name: 'Ethereum', chainFamily: 'evm', decimals: 18, caip: 'eip155:8453/slip44:60' }
const spender = '0x0000000000001ff3684f28c67538d4d072c22734'
let serial = 0
const quote = () => {
  const n = ++serial
  return {
    quoteId: `quote-${n}`, quoteCreatedAt: Date.now(), quoteExpiresAt: Date.now() + 60_000,
    expectedOutput: (0.04 + n / 10_000).toFixed(4), minimumOutput: '0.039', inboundAddress: spender, memo: '',
    fees: { affiliate: '0', outbound: '0', totalBps: 0 }, estimatedTime: 30, slippageBps: 100,
    integration: 'zeroex', swapper: '0x', relayTx: { to: spender, data: `0x2213bc0b${String(n).padStart(8, '0')}`, value: '0', chainId: 8453 },
    risk: { tier: 'small', blocked: false, warning: false, requiresAcknowledgment: false, quoteMaxAgeMs: 60_000, allowancePct: 1 },
  }
}
const approveTx = { chainId: 8453, to: token, data: '0x095ea7b3' + spender.slice(2).padStart(64, '0') + (100_000_000).toString(16).padStart(64, '0'), value: '0x0', gasLimit: '0x13880', nonce: '0x1' }
const preview = (params: any) => ({
  approveTx, unsignedTx: { chainId: 8453, to: spender, data: params.relayTx?.data, value: '0x0', gasLimit: '0xaae60', nonce: '0x2' },
  allowance: { current: '0', required: '100', sufficient: false, spender, tokenContract: token },
  balance: { current: '1000', required: '100', sufficient: true, tokenContract: token },
})

const calls: { method: string; params: any; at: number }[] = []
let previewBusy = 0
let execute: Array<() => Promise<unknown>> = []
let state: any = null
const listeners: Record<string, ((message: any) => void) | undefined> = {}
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: async (method: string, params: any) => {
    calls.push({ method, params, at: Date.now() })
    switch (method) {
      case 'getSwapAssets': return [usdc, eth]
      case 'getBalances': case 'getCustomTokens': return []
      case 'getCachedBalances': return null
      case 'getSwapHealth': return { fetchedAt: Date.now(), integrations: [] }
      case 'getSwapQuote': return quote()
      case 'previewSwapBuild': if (previewBusy > 0) { previewBusy--; throw new Error(BUSY) } return preview(params)
      case 'executeSwap': { const next = execute.shift(); if (!next) throw new Error('unexpected executeSwap'); return next() }
      default: return {}
    }
  },
  rpcFire(method: string, payload: any) { if (method === 'publishSwapUiState') state = payload },
  onRpcMessage: (name: string, handler: (message: any) => void) => { listeners[name] = handler; return () => { if (listeners[name] === handler) listeners[name] = undefined } },
}))
// Hook results are stable across renders, as the real hooks' state is.
const evm = { evmAddresses: { addresses: [{ addressIndex: 0, address: owner }], selectedIndex: 0, totalBalanceUsd: 0 }, initialLoaded: true, refresh: async () => {}, selectIndex() {} }
const deviceState = { firmwareVersion: '7.17.0' }
mock.module('../../src/mainview/hooks/useEvmAddresses', () => ({ useEvmAddresses: () => evm }))
mock.module('../../src/mainview/hooks/useDeviceState', () => ({ useDeviceState: () => deviceState }))
const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
await import('../../src/mainview/i18n')
const { SwapDialog } = await import('../../src/mainview/components/SwapDialog')

const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const text = () => container.textContent || ''
const seen: string[] = [] // everything the dialog ever showed, sampled while waiting
const settle = async (ms = 50) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }); seen.push(text(), String(state?.error ?? '')) }
const until = async (condition: () => boolean, label: string, ms = 15_000) => {
  for (const started = Date.now(); !condition();) {
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${label}; phase=${state?.phase} error=${state?.error}`)
    await settle()
  }
}
const command = async (cmd: any) => { await act(async () => { listeners['swap-cmd']!(cmd) }); await settle() }
const count = (method: string) => calls.filter(call => call.method === method).length
const shown = (needle: RegExp) => seen.some(sample => needle.test(sample))
const toReview = async () => {
  seen.length = 0
  await command({ kind: 'set', fromAssetDefinition: usdc, fromAsset: usdc.asset, toAssetDefinition: eth, toAsset: eth.asset, amount: '100', inputMode: 'crypto' })
  await until(() => !!state?.quote?.quoteId && state.phase === 'input', 'a quote')
  await command({ kind: 'advance' })
  await until(() => state?.phase === 'review' && !!state?.previewBuild?.unsignedTx, 'a built payload')
}
const result: Record<string, unknown> = {}
try {
  await act(async () => { root.render(<ChakraProvider value={defaultSystem}><SwapDialog open onClose={() => {}} /></ChakraProvider>) })
  await until(() => !!listeners['swap-cmd'], 'the swap command listener')

  // 1. The reported failure: the payload build meets a KeepKey still held by another request.
  previewBusy = 2
  const previewsBefore = count('previewSwapBuild')
  await toReview()
  result.previewWaitsOutBusyDevice = count('previewSwapBuild') - previewsBefore === 3
  result.previewBusyNeverShown = !shown(/Build preview failed|busy with another request/)

  // 2. Execute meets a busy KeepKey, then the quote ages out while the approval confirms.
  const reviewed = state.quote
  const quotesBefore = count('getSwapQuote')
  execute = [
    async () => { throw new Error(BUSY) },
    async () => {
      for (const stage of ['approve-signing', 'approve-broadcasting', 'approve-waiting-receipt', 'swap-signing']) await act(async () => { listeners['swap-substage']?.({ stage }) })
      throw new Error('The approval was sent, but the swap quote expired while it confirmed. Get a new quote to finish the swap.')
    },
  ]
  seen.length = 0
  await command({ kind: 'confirm' })
  await until(() => state?.phase === 'review' && state?.quote?.quoteId !== reviewed.quoteId && !!state?.previewBuild?.unsignedTx, 'a fresh quote to review')
  const executes = calls.filter(call => call.method === 'executeSwap')
  result.executeWaitsOutBusyDevice = executes.length === 2 && executes[0].params.quoteId === reviewed.quoteId && executes[1].params.quoteId === reviewed.quoteId
  result.agedQuoteRequotedOnce = count('getSwapQuote') - quotesBefore === 1
  const rebuilt = calls.filter(call => call.method === 'previewSwapBuild' && call.at >= executes[1].at)
  result.payloadBuiltOnlyForFreshQuote = rebuilt.length === 1 && rebuilt[0].params.relayTx.data === state.quote.relayTx.data
  result.reviewAsksForOneConfirm = /Quote refreshed\. Review the rebuilt payload before confirming\./.test(String(state.error))
  result.expiryAndBusyNeverShown = !shown(/quote expired|quote has expired|busy with another request/i)

  // 3. Cancel while waiting for a busy KeepKey: no execution starts afterwards.
  execute = Array.from({ length: 50 }, () => async () => { throw new Error(BUSY) })
  const executesBeforeCancel = count('executeSwap')
  seen.length = 0
  await command({ kind: 'confirm' })
  await until(() => state?.phase === 'approving' && count('executeSwap') - executesBeforeCancel >= 2, 'an execution waiting on the KeepKey')
  const cancel = container.querySelector('button[aria-label="Cancel"]')
  await act(async () => { cancel?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await until(() => state?.phase === 'review', 'the cancelled review')
  const afterCancel = count('executeSwap')
  await settle(1_200)
  result.cancelEndsDeviceWait = !!cancel && count('executeSwap') === afterCancel
  result.cancelMessageKept = /Swap cancelled/.test(String(state.error)) && !shown(/busy with another request/)

  // 4. Cancel aged the quote: Confirm refreshes it for review and executes nothing.
  await until(() => !!state?.previewBuild?.unsignedTx, 'the rebuilt payload after cancel')
  execute = []
  const staleQuote = state.quote, executesBeforeStale = count('executeSwap')
  await command({ kind: 'confirm' })
  await until(() => state?.phase === 'review' && state?.quote?.quoteId !== staleQuote.quoteId && !!state?.previewBuild?.unsignedTx, 'a refreshed quote')
  result.agedConfirmRefreshesWithoutExecuting = count('executeSwap') === executesBeforeStale

  // 5. Other failures are still reported and never retried.
  execute = [async () => { throw new Error('Insufficient funds for gas') }]
  await command({ kind: 'confirm' })
  await until(() => state?.phase === 'review' && /Not enough gas/.test(String(state?.error)), 'the gas error')
  result.otherErrorsSurface = count('executeSwap') - executesBeforeStale === 1
} catch (error: any) {
  result.error = error?.message || String(error)
} finally {
  await act(async () => root.unmount())
}
console.log('SWAP_DIALOG_DEVICE_WAIT_RESULT ' + JSON.stringify(result))
