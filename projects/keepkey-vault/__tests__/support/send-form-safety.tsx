// Actual SendForm with the real address validators and deferred RPCs. No device, network, or wallet storage.
import { JSDOM } from 'jsdom'
import { expect, mock } from 'bun:test'
import * as React from 'react'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const translate = (key: string) => key
let uiLanguage = 'en'
const element = (tag: string) => (props: any) => {
  const attrs = Object.fromEntries(Object.entries(props).filter(([key]) => /^(on[A-Z]|aria-|data-)/.test(key)
    || ['value', 'disabled', 'placeholder', 'title', 'role', 'type', 'checked'].includes(key)))
  return React.createElement(tag, attrs, props.children)
}
mock.module('@chakra-ui/react', () => ({ Box: element('div'), Flex: element('div'), Text: element('span'),
  VStack: element('div'), Button: element('button'), Input: element('input'), Spinner: element('span') }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: translate, i18n: { get language() { return uiLanguage } } }) }))
mock.module('../../src/mainview/i18n/ui', () => ({ useUiTranslation: () => translate }))
mock.module('../../src/mainview/lib/fiat-context', () => ({ useFiat: () => ({ locale: 'en-US', fmt: String, fmtCompact: String }) }))
mock.module('../../src/mainview/lib/formatting', () => ({ formatBalance: String }))
mock.module('../../src/mainview/lib/signing-errors', () => ({ describeSigningError: (error: Error) => error.message }))
mock.module('../../src/mainview/lib/sounds', () => ({ playSent() {} }))
mock.module('../../src/shared/assetLookup', () => ({ getAsset: () => null }))
mock.module('../../src/mainview/components/QrScannerOverlay', () => ({ QrScannerOverlay: () => null }))
mock.module('../../src/mainview/components/AddressBookPicker', () => ({ AddressBookPicker: () => null }))
mock.module('../../src/mainview/components/AddressIdenticon', () => ({ AddressIdenticon: () => null }))
mock.module('../../src/mainview/components/SaveRecipientDialog', () => ({ SaveRecipientDialog: () => null }))
mock.module('../../src/mainview/components/DocsLink', () => ({ DocsLink: () => null }))

function deferred() {
  let resolve!: (value: any) => void, reject!: (error: Error) => void
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const contracts = new Set<string>()
const calls: Array<{ method: string; params: any; pending: ReturnType<typeof deferred> }> = []
const lookups: string[] = []
mock.module('../../src/mainview/lib/rpc', () => ({ rpcRequest: async (method: string, params: any) => {
  lookups.push(method)
  if (method === 'checkVaultDestination') return undefined
  if (method === 'matchAddress') return null // every test recipient is new
  if (method === 'getFees') return { gasPrice: { average: '0.006', fast: '0.007' }, unit: 'gwei' }
  if (method === 'isEvmContract') return contracts.has(params.address.toLowerCase())
  if (!['buildTx', 'ethSignTx', 'broadcastTx'].includes(method)) throw new Error(`Unexpected RPC: ${method}`)
  const pending = deferred(); calls.push({ method, params, pending }); return pending.promise
} }))
globalThis.fetch = (() => { throw new Error('Network forbidden in SendForm fixture') }) as typeof fetch
const { act } = React
const { createRoot } = await import('react-dom/client')
const { CHAINS } = await import('../../src/shared/chains')
const { GAS_PRICE_ERROR } = await import('../../src/shared/gas-price-errors')
const { SendForm } = await import('../../src/mainview/components/SendForm')
const chain = CHAINS.find(c => c.id === 'ethereum')!
const owner = '0x' + '11'.repeat(20), recipient = '0x' + '33'.repeat(20), tokenContract = '0x' + '44'.repeat(20)
const balance = { chainId: chain.id, balance: '10', balanceUsd: 30000, nativeBalanceUsd: 30000, address: owner, syncState: 'confirmed' }
const token = { caip: `${chain.networkId}/erc20:${tokenContract}`, contractAddress: tokenContract, symbol: 'TEST', name: 'Test', balance: '10', balanceUsd: 10, priceUsd: 1, decimals: 6 }
let props: any, container: HTMLDivElement, root: ReturnType<typeof createRoot>
const settle = async (ms = 0) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
const render = async (patch = {}) => { props = { ...props, ...patch }; await act(async () => root.render(<SendForm {...props} />)); await settle() }
const mount = async (patch = {}) => {
  calls.length = 0; lookups.length = 0
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  props = { chain, address: owner, balance, evmAddressIndex: 0, ...patch }; await render()
}
const unmount = async () => { await act(async () => root.unmount()); container.remove() }
const text = () => container.textContent || ''
const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label)!
const input = (placeholder: string) => container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!
const checkbox = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')
const dispatchClick = (node: Element) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const setInput = async (placeholder: string, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input(placeholder), value)
    input(placeholder).dispatchEvent(new window.Event('input', { bubbles: true }))
  }); await settle()
}
const fill = async (to = recipient, amount = '1') => { await setInput('addressPlaceholder', to); if (amount) await setInput('amountPlaceholder', amount); await settle(340) }
const click = async (label: string) => { expect(button(label)).toBeDefined(); expect(button(label).disabled).toBe(false)
  await act(async () => dispatchClick(button(label))); await settle() }
const complete = async (call: typeof calls[number], value: any) => { await act(async () => call.pending.resolve(value)); await settle() }
const fail = async (call: typeof calls[number], message: string) => { await act(async () => call.pending.reject(new Error(message))); await settle() }
const built = (fee: string, unsignedTx: any = { fixture: 'transaction' }) => ({ unsignedTx, fee })
const summary: Record<string, unknown> = {}

// H2: Custom shows the network quote; empty Custom builds at that quote; bound errors are translated.
await mount(); await fill()
expect(lookups).not.toContain('getFees') // presets never fetch it
await act(async () => dispatchClick([...container.querySelectorAll('span')].find(n => n.textContent === 'feeCustom')!)); await settle()
expect(input('0.006')).not.toBeNull()
await click('buildTransaction')
expect(calls.at(-1)!.params).toMatchObject({ feeLevel: 3, gasPriceGwei: undefined })
await complete(calls.at(-1)!, built('0.0000001')); await click('back')
await setInput('0.006', '20'); await click('buildTransaction')
await fail(calls.at(-1)!, `${GAS_PRICE_ERROR.tooHigh} (0.006 gwei)`)
expect(text()).toContain('customGasPriceTooHigh'); expect(text()).not.toContain(GAS_PRICE_ERROR.tooHigh)
summary.customGasQuote = true
await unmount()

// H2: a token send whose fee is worth more than 25% of the tokens (in USD) is flagged.
for (const [fee, warned] of [['0.001', true], ['0.00000001', false]] as const) {
  await mount({ token }); await fill(); await click('buildTransaction'); await complete(calls.at(-1)!, built(fee))
  expect(text().includes('feeOverQuarter')).toBe(warned)
  await unmount()
}
summary.tokenFeeWarning = true

// V7: zero/burn and token-contract recipients need an explicit acknowledgement;
// the token's own contract is refused; any other contract gets a note.
const ackCases = [['0x000000000000000000000000000000000000dEaD', 'recipientBurnTitle'], ['0x0000000000000000000000000000000000000000', 'recipientBurnTitle'],
  ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'recipientTokenContractTitle']] as const
for (const [to, title] of ackCases) {
  await mount(); await fill(to)
  expect(text()).toContain(title); expect(button('buildTransaction').disabled).toBe(true)
  await act(async () => dispatchClick(checkbox()!)); await settle()
  expect(button('buildTransaction').disabled).toBe(false)
  await unmount()
}
await mount({ token }); await fill(tokenContract)
expect(text()).toContain('recipientIsSentToken'); expect(checkbox()).toBeNull(); expect(button('buildTransaction').disabled).toBe(true)
await unmount()
contracts.add('0x' + '55'.repeat(20))
await mount(); await fill('0x' + '55'.repeat(20))
expect(text()).toContain('recipientContractNote'); expect(button('buildTransaction').disabled).toBe(false)
await unmount()
await mount(); await fill()
expect(text()).not.toContain('recipientContractNote'); expect(text()).not.toContain('recipientBurnTitle')
await unmount()
summary.recipientRisk = ackCases.length + 2

// V13: MAX review shows the amount the transaction actually sends, and history records it.
await mount(); await setInput('addressPlaceholder', recipient); await settle(340); await click('max'); await click('buildTransaction')
await complete(calls.at(-1)!, built('0.0001', { value: '0x' + (95n * 10n ** 17n).toString(16), to: recipient }))
expect(text()).toContain('9.5 ETH'); expect(text()).not.toContain('MAX ETH')
await click('signOnDevice'); await complete(calls.at(-1)!, 'signed max')
await click('broadcastTransaction'); expect(calls.at(-1)!.params).toMatchObject({ amount: '9.5' })
await unmount()
const transfer = '0xa9059cbb' + recipient.slice(2).padStart(64, '0') + (2_500_000n).toString(16).padStart(64, '0')
await mount({ token }); await setInput('addressPlaceholder', recipient); await settle(340); await click('max'); await click('buildTransaction')
await complete(calls.at(-1)!, built('0.0001', { value: '0x0', to: tokenContract, data: transfer }))
expect(text()).toContain('2.5 TEST'); expect(text()).not.toContain('MAX TEST')
await unmount()
summary.maxReview = true

// V9: a comma-decimal UI language accepts "0,5" on the default en-US number format.
uiLanguage = 'pt'
await mount(); await fill(recipient, '0,5')
expect(text()).not.toContain('invalidAmount')
await click('buildTransaction'); expect(calls.at(-1)!.params).toMatchObject({ amount: '0.5' })
await unmount()
uiLanguage = 'en'
await mount(); await fill(recipient, '0,5'); expect(text()).toContain('invalidAmount')
await unmount()
summary.commaDecimal = true

// V12: a double-click on Broadcast. Both clicks land before React commits
// `disabled` (same task): the handler's own latch lets exactly one broadcast out.
await mount(); await fill(); await click('buildTransaction'); await complete(calls.at(-1)!, built('0.0001'))
await click('signOnDevice'); await complete(calls.at(-1)!, 'signed')
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = false
const broadcastButton = button('broadcastTransaction')
dispatchClick(broadcastButton)
dispatchClick(broadcastButton)
await new Promise(resolve => setTimeout(resolve, 0))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
summary.doubleClickBroadcasts = calls.filter(call => call.method === 'broadcastTx').length
await settle(); await unmount()

console.log(JSON.stringify(summary))
