// The actual SwapDialog input → review path with synthetic RPC replies: no wallet, device or network.
// Audit v4 H1 (recipient), V1 (slippage), V6 (own custom recipient), V14 (output switch), V15 (opacity), H7 (degraded MAX).
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'getComputedStyle', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(window as any).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const owner = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const second = '0x2222222222222222222222222222222222222222'
const external = '0x1111111111111111111111111111111111111111'
const usdcArb = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
const baseEth = { asset: 'BASE.ETH', chainId: 'base', symbol: 'ETH', name: 'Ethereum', chainFamily: 'evm', decimals: 18, caip: 'eip155:8453/slip44:60' }
const arbEth = { asset: 'ARB.ETH', chainId: 'arbitrum', symbol: 'ETH', name: 'Ethereum', chainFamily: 'evm', decimals: 18, caip: 'eip155:42161/slip44:60' }
const arbUsdc = { asset: 'ARB.USDC', chainId: 'arbitrum', symbol: 'USDC', name: 'USD Coin', chainFamily: 'evm', decimals: 6, caip: `eip155:42161/erc20:${usdcArb}`, contractAddress: usdcArb }
const FEE_GATE = 'Swap amount too low: quoted fees (20.79%) meet or exceed the slippage allowance (1.00%), so the protocol would refund this swap on-chain — minus another network fee. Increase the amount or choose Custom slippage above 20.79%.'

let serial = 0
let relayOrderRecipient: ((params: any) => string | undefined) | undefined
const quote = (params: any) => {
  const n = ++serial
  if (params.toCaip === arbUsdc.caip) throw new Error(FEE_GATE)
  return {
    expectedOutput: '0.0099', minimumOutput: '0.0098', inboundAddress: '', memo: '',
    fees: { affiliate: '0', outbound: '0', totalBps: 0 }, estimatedTime: 30, slippageBps: 50,
    integration: 'relay', swapper: 'relay', executionMode: 'relay-solver-deposit',
    relayTx: { to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', data: '0x49290c1c' + '0'.repeat(128), value: '10000000000000000', chainId: 8453 },
    relayOrder: { recipient: relayOrderRecipient ? relayOrderRecipient(params) : params.toAddress },
    relayOrderRecipient: relayOrderRecipient ? relayOrderRecipient(params) : params.toAddress,
    quoteId: `quote-${n}`, quoteCreatedAt: Date.now(), quoteExpiresAt: Date.now() + 60_000,
    risk: { tier: 'small', blocked: false, warning: false, requiresAcknowledgment: false, quoteMaxAgeMs: 60_000, allowancePct: 1 },
  }
}
const calls: { method: string; params: any }[] = []
let state: any = null
const listeners: Record<string, ((message: any) => void) | undefined> = {}
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: async (method: string, params: any) => {
    calls.push({ method, params })
    switch (method) {
      case 'getSwapAssets': return [baseEth, arbEth, arbUsdc]
      case 'getBalances': case 'getCustomTokens': return []
      case 'getCachedBalances': return null
      case 'getSwapHealth': return { fetchedAt: Date.now(), integrations: [] }
      case 'getSwapQuote': return quote(params)
      case 'previewSwapBuild': return { unsignedTx: { chainId: 8453, to: params.relayTx?.to, data: params.relayTx?.data, value: '0x2386f26fc10000', gasLimit: '0x7fb9', nonce: '0x1' } }
      case 'executeSwap': return { txid: '0x' + 'e'.repeat(64) }
      // The on-chain native read (Pioneer EvmReadRpc in the real handler).
      case 'verifyTokenBalance': return { balance: params.owner.toLowerCase() === owner.toLowerCase() ? '0.5' : '0.25' }
      default: return {}
    }
  },
  rpcFire(method: string, payload: any) { if (method === 'publishSwapUiState') state = payload },
  onRpcMessage: (name: string, handler: (message: any) => void) => { listeners[name] = handler; return () => { if (listeners[name] === handler) listeners[name] = undefined } },
}))
// Pioneer's portfolio is degraded: neither account's Base row vouches for its ETH.
const degraded = (address: string) => ({ base: { chainId: 'base', symbol: 'ETH', balance: '0', balanceUsd: 0, address, syncState: 'degraded' } })
const evm = {
  evmAddresses: { addresses: [{ addressIndex: 0, address: owner, chainBalances: degraded(owner) }, { addressIndex: 1, address: second, chainBalances: degraded(second) }], selectedIndex: 0, totalBalanceUsd: 0 },
  initialLoaded: true, refresh: async () => {}, selectIndex() {},
}
const deviceState = { firmwareVersion: '7.17.0' }
mock.module('../../src/mainview/hooks/useEvmAddresses', () => ({ useEvmAddresses: () => evm }))
mock.module('../../src/mainview/hooks/useDeviceState', () => ({ useDeviceState: () => deviceState }))

// A 30% tolerance saved by an older build must not come back.
localStorage.setItem('swap.slippageBps', '3000')

const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
await import('../../src/mainview/i18n')
const { SwapDialog } = await import('../../src/mainview/components/SwapDialog')

const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const text = () => container.textContent || ''
const settle = async (ms = 50) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
const until = async (condition: () => boolean, label: string, ms = 10_000) => {
  for (const started = Date.now(); !condition();) {
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${label}; phase=${state?.phase} error=${state?.error}`)
    await settle()
  }
}
const command = async (cmd: any) => { await act(async () => { listeners['swap-cmd']!(cmd) }); await settle() }
const count = (method: string) => calls.filter(call => call.method === method).length
const click = async (el: Element | null | undefined) => { await act(async () => { el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }); await settle() }
const confirmButton = () => Array.from(container.querySelectorAll('button')).find(b => /Confirm|Swap|Review|Waiting|Refresh|payload|Relay|slippage/i.test(b.textContent || '') && b.getAttribute('aria-disabled') !== null)
const recipientRow = () => container.querySelector('[data-trade-recipient]')
const toInput = async (fields: any) => {
  await command({ kind: 'set', fromAssetDefinition: baseEth, fromAsset: baseEth.asset, toAssetDefinition: arbEth, toAsset: arbEth.asset, amount: '0.01', inputMode: 'crypto', useCustomAddress: false, customToAddress: '', ...fields })
}
const toReview = async (fields: any = {}) => {
  await toInput(fields)
  await until(() => !!state?.quote?.quoteId && state.phase === 'input', 'a quote')
  await command({ kind: 'advance' })
  await until(() => state?.phase === 'review' && !!container.querySelector('[data-trade-summary]'), 'the review')
  await settle(100)
}
const result: Record<string, unknown> = {}
try {
  await act(async () => { root.render(<ChakraProvider value={defaultSystem}><SwapDialog open onClose={() => {}} /></ChakraProvider>) })
  await until(() => !!listeners['swap-cmd'], 'the swap command listener')
  await settle(100)

  // V1: the stored 30% is not restored.
  result.storedHighSlippageIgnored = state?.slippageBps === 100

  // V15: the dialog hides the page under it (no reliance on backdrop-filter).
  const alpha = (el: Element | null) => {
    const m = /rgba?\(([^)]+)\)/.exec(el ? getComputedStyle(el).backgroundColor : '')
    const parts = m ? m[1].split(',').map(Number) : []
    return parts.length === 4 ? parts[3] : parts.length === 3 ? 1 : 0
  }
  const backdrop = container.ownerDocument.querySelector('[data-testid="swap-backdrop"]')
  result.backdropOpaqueEnough = alpha(backdrop) >= 0.7
  result.panelOpaque = alpha(container.ownerDocument.querySelector('[data-swap-panel]')) >= 0.95

  // H7: Base ETH while Pioneer's portfolio is degraded — the on-chain read gives MAX and the account list a figure.
  await toInput({})
  await settle(300)
  const max = Array.from(container.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'MAX' || (b.textContent || '').trim() === 'Max')
  result.maxEnabledFromOnChainRead = !!max && !(max as HTMLButtonElement).disabled
  const options = Array.from(container.querySelectorAll('select option')).map(o => o.textContent || '')
  result.accountOptionsShowOnChainBalance = options.length === 2 && options[0].includes('0.5') && options[1].includes('0.25') && !options.some(o => /unverified/i.test(o))

  // H1: zero and burn custom recipients never reach a quote.
  for (const burn of ['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dEaD']) {
    await toInput({ useCustomAddress: true, customToAddress: burn })
    await settle(400)
    result[`burnRefused_${burn.slice(-4)}`] = !calls.some(c => c.method === 'getSwapQuote' && c.params.toAddress === burn) && /burn address/i.test(text())
  }

  // V3: a mis-cased (mistyped) EVM custom recipient is refused with the translated checksum text.
  const badChecksum = '0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
  await toInput({ useCustomAddress: true, customToAddress: badChecksum })
  await settle(400)
  result.badChecksumRefused = !calls.some(c => c.method === 'getSwapQuote' && c.params.toAddress === badChecksum)
    && text().includes('Checksum mismatch') && !text().includes('invalidEvmChecksum')

  // H1: own-address review shows the full recipient, not as custom.
  await toReview()
  result.ownRecipientRowShown = !!recipientRow() && (recipientRow()!.textContent || '').includes(owner) && recipientRow()!.getAttribute('data-custom-recipient') === 'false'
  result.relayCopyTruthful = !text().includes("destination terms are shown in this app") && text().includes(`The Relay order pays out to ${owner}`)

  // H1: an external recipient is red-flagged at the top of the review.
  await toReview({ useCustomAddress: true, customToAddress: external })
  result.customRecipientRowShown = !!recipientRow() && (recipientRow()!.textContent || '').includes(external)
    && recipientRow()!.getAttribute('data-custom-recipient') === 'true' && /Custom recipient — not your KeepKey/.test(recipientRow()!.textContent || '')

  // H1: a Relay order that does not pay the entered recipient keeps Confirm locked.
  relayOrderRecipient = () => second
  await toReview({ useCustomAddress: true, customToAddress: external })
  const executesBeforeMismatch = count('executeSwap')
  await command({ kind: 'confirm' })
  await click(confirmButton())
  result.relayMismatchLocked = count('executeSwap') === executesBeforeMismatch && confirmButton()?.getAttribute('aria-disabled') === 'true'
  relayOrderRecipient = undefined

  // V6: the user's own KeepKey address pasted as the custom recipient is not "external".
  await toInput({ useCustomAddress: true, customToAddress: owner.toLowerCase() })
  await settle(300)
  result.ownCustomNotExternal = !text().includes('Funds will be sent to this external address') && text().includes('This is your own KeepKey address')
  await toReview({ useCustomAddress: true, customToAddress: owner.toLowerCase() })
  result.ownCustomReviewNotFlagged = recipientRow()?.getAttribute('data-custom-recipient') === 'false'

  // V1: only tolerances up to 3% are remembered.
  await command({ kind: 'set', slippageBps: 3000 })
  result.highSlippageNotPersisted = localStorage.getItem('swap.slippageBps') !== '3000'
  await command({ kind: 'set', slippageBps: 200 })
  result.lowSlippagePersisted = localStorage.getItem('swap.slippageBps') === '200'

  // V1: above 5% the swap needs an explicit confirmation, then the custom value resets.
  await toReview({ slippageBps: 600 })
  const executesBeforeSlippage = count('executeSwap')
  await command({ kind: 'confirm' })
  await click(confirmButton())
  result.highSlippageNeedsConfirm = count('executeSwap') === executesBeforeSlippage
  const ack = container.querySelector('[data-high-slippage-ack] input[type="checkbox"]')
  await click(ack)
  await click(confirmButton())
  await until(() => count('executeSwap') > executesBeforeSlippage, 'the swap after confirming slippage')
  // Bun enforces the same confirmation (swap-quote-lease): the dialog must say it was given.
  result.slippageAckSent = calls.filter(c => c.method === 'executeSwap').at(-1)?.params?.slippageAcknowledged === true
  await settle(200)
  result.customSlippageResetAfterSwap = state?.slippageBps === 100 && localStorage.getItem('swap.slippageBps') !== '600'

  // V14: a fee-gate error for one output clears when the output changes.
  await command({ kind: 'close' })
  await act(async () => { root.render(<ChakraProvider value={defaultSystem}><SwapDialog open onClose={() => {}} /></ChakraProvider>) })
  await settle(200)
  await command({ kind: 'set', fromAssetDefinition: baseEth, fromAsset: baseEth.asset, toAssetDefinition: arbUsdc, toAsset: arbUsdc.asset, amount: '0.01', inputMode: 'crypto' })
  await until(() => /Swap amount too low/.test(text()), 'the fee-gate error')
  await command({ kind: 'set', toAssetDefinition: arbEth, toAsset: arbEth.asset })
  await until(() => !!state?.quote?.quoteId, 'the new pair quote')
  result.outputSwitchClearsError = !/Swap amount too low/.test(text()) && !state?.error
} catch (error: any) {
  result.error = error?.message || String(error)
} finally {
  await act(async () => root.unmount())
}
console.log('SWAP_DIALOG_REVIEW_RESULT ' + JSON.stringify(result))
