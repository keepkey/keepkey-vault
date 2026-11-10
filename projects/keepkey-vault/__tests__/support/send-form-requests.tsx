// Actual SendForm state with deferred RPCs. No device, network, or wallet storage.
import { JSDOM } from 'jsdom'
import { expect, mock } from 'bun:test'
import * as React from 'react'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const translate = (key: string) => key
const element = (tag: string) => (props: any) => {
  const attrs = Object.fromEntries(Object.entries(props).filter(([key]) => /^(on[A-Z]|aria-|data-)/.test(key)
    || ['value', 'disabled', 'placeholder', 'title', 'role', 'type'].includes(key)))
  return React.createElement(tag, attrs, props.children)
}
mock.module('@chakra-ui/react', () => ({ Box: element('div'), Flex: element('div'), Text: element('span'),
  VStack: element('div'), Button: element('button'), Input: element('input'), Spinner: element('span') }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }))
mock.module('../../src/mainview/i18n/ui', () => ({ useUiTranslation: () => translate }))
mock.module('../../src/mainview/lib/fiat-context', () => ({ useFiat: () => ({ locale: 'en-US', fmt: String, fmtCompact: String }) }))
mock.module('../../src/mainview/lib/formatting', () => ({ formatBalance: String }))
mock.module('../../src/mainview/lib/signing-errors', () => ({ describeSigningError: (error: Error) => error.message }))
mock.module('../../src/mainview/lib/sounds', () => ({ playSent() {} }))
mock.module('../../src/shared/assetLookup', () => ({ getAsset: () => null }))
mock.module('../../src/shared/address-validation', () => ({ validateAddress: () => ({ valid: true }) }))
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
const calls: Array<{ method: string; params: any; pending: ReturnType<typeof deferred> }> = []
mock.module('../../src/mainview/lib/rpc', () => ({ onRpcMessage: () => () => {}, rpcRequest: async (method: string, params: any) => {
  if (method === 'checkVaultDestination') return undefined
  if (method === 'matchAddress') return { address: params.address, kind: 'external', label: 'Known test recipient' }
  if (!['buildTx', 'ethSignTx', 'broadcastTx'].includes(method)) throw new Error(`Unexpected RPC: ${method}`)
  const pending = deferred(); calls.push({ method, params, pending }); return pending.promise
} }))
globalThis.fetch = (() => { throw new Error('Network forbidden in SendForm fixture') }) as typeof fetch
const { act } = React
const { createRoot } = await import('react-dom/client')
const { CHAINS } = await import('../../src/shared/chains')
const { SendForm } = await import(process.env.SEND_FORM_UNDER_TEST || '../../src/mainview/components/SendForm')
const chain = CHAINS.find(c => c.id === 'ethereum')!
const owner = '0x' + '11'.repeat(20), otherOwner = '0x' + '22'.repeat(20), recipient = '0x' + '33'.repeat(20)
const balance = { chainId: chain.id, balance: '10', balanceUsd: 10000, address: owner, syncState: 'confirmed' }
const token = { caip: `${chain.networkId}/erc20:0x${'44'.repeat(20)}`, symbol: 'TEST', balance: '10', balanceUsd: 10, decimals: 18 }
const result = { unsignedTx: { fixture: 'transaction' }, fee: '1', feeUsd: 1 }
let props: any, container: HTMLDivElement, root: ReturnType<typeof createRoot>
const settle = async (ms = 0) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
const render = async (patch = {}) => { props = { ...props, ...patch }; await act(async () => root.render(<SendForm {...props} />)); await settle() }
const mount = async (patch = {}) => {
  calls.length = 0
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  props = { chain, address: owner, balance, evmAddressIndex: 0, ...patch }; await render()
}
const unmount = async () => { await act(async () => root.unmount()); container.remove() }
const text = () => container.textContent || ''
const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label)!
const input = (placeholder: string) => container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!
const setInput = async (placeholder: string, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input(placeholder), value)
    input(placeholder).dispatchEvent(new window.Event('input', { bubbles: true }))
  }); await settle()
}
const fill = async () => { await setInput('addressPlaceholder', recipient); await setInput('amountPlaceholder', '1'); await settle(340) }
const click = async (label: string) => { expect(button(label)).toBeDefined(); expect(button(label).disabled).toBe(false)
  await act(async () => button(label).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))); await settle() }
const complete = async (call: typeof calls[number], value: any = result) => { await act(async () => call.pending.resolve(value)); await settle() }
const fail = async (call: typeof calls[number]) => { await act(async () => call.pending.reject(new Error('retired failure'))); await settle() }
const ready = () => text().includes('transactionReady')
const summary: Record<string, unknown> = {}

// An unresolved EVM owner is not the default derivation account. Keep the
// draft editable, but never build with an inferred index while it is missing.
await mount({ address: null, evmAddressIndex: undefined, balance: undefined, balanceLoading: true })
await fill()
expect(button('buildTransaction').disabled).toBe(true); expect(button('max').disabled).toBe(true)
await act(async () => button('buildTransaction').dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
expect(calls).toHaveLength(0)
await render({ balanceLoading: false }) // A failed owner read must stay blocked, too.
expect(button('buildTransaction').disabled).toBe(true)
await render({ address: otherOwner, evmAddressIndex: 2, balanceLoading: true })
expect(input('amountPlaceholder').value).toBe('1'); expect(input('addressPlaceholder').value).toBe(recipient)
await click('buildTransaction')
expect(calls.at(-1)!.params).toMatchObject({ evmAddressIndex: 2, amount: '1' })
await complete(calls.at(-1)!); expect(button('signOnDevice').disabled).toBe(false)
await render({ address: null, evmAddressIndex: undefined })
expect(button('signOnDevice')).toBeUndefined(); expect(calls.filter(call => call.method === 'ethSignTx')).toHaveLength(0)
summary.senderReadiness = true
await unmount()

await mount(); await click('max')
await render({ address: null, evmAddressIndex: undefined, balanceLoading: false })
expect(button('buildTransaction').disabled).toBe(true); expect(button('max').disabled).toBe(true)
expect(calls).toHaveLength(0)
await render({ address: otherOwner, evmAddressIndex: 2 })
await setInput('addressPlaceholder', recipient); await settle(340)
await click('buildTransaction'); expect(calls.at(-1)!.params).toMatchObject({ evmAddressIndex: 2, isMax: true })
await complete(calls.at(-1)!); await unmount()

await mount(); await fill(); await click('buildTransaction'); const retiredBuild = calls.at(-1)!
await render({ evmAddressIndex: 1, address: otherOwner }); await complete(retiredBuild)
expect(ready()).toBe(false); summary.retiredBuild = true
await unmount()

// A late failure/finally cannot replace a newer build's loading state.
await mount(); await fill(); await click('buildTransaction'); const firstBuild = calls.at(-1)!
await setInput('amountPlaceholder', '2'); await click('buildTransaction'); const secondBuild = calls.at(-1)!
await fail(firstBuild)
expect(text()).not.toContain('retired failure'); expect(button('buildingTransaction').disabled).toBe(true)
await complete(secondBuild); expect(ready()).toBe(true); expect(text()).toContain('2 ETH')
summary.editedBuild = true
await unmount()

// Each actual signing identity invalidates an outstanding build.
const identities = [{ address: otherOwner }, { evmAddressIndex: 1 }, { token },
  { chain: { ...chain, id: 'base', caip: 'eip155:8453/slip44:60' } },
  { xpubOverride: 'verified-public-xpub' }, { scriptTypeOverride: 'p2tr' }]
for (const patch of identities) {
  await mount(); await fill(); await click('buildTransaction'); const pending = calls.at(-1)!
  await render(patch); await complete(pending)
  expect(ready()).toBe(false); expect(text()).not.toContain('transactionSigned'); expect(text()).not.toContain('retired failure')
  await unmount()
}
summary.identities = identities.length

// A signature from a retired review cannot appear, broadcast, or end a newer sign.
await mount(); await fill(); await click('buildTransaction'); await complete(calls.at(-1)!)
await click('signOnDevice'); const firstSign = calls.at(-1)!
await click('back'); await setInput('amountPlaceholder', '2'); await click('buildTransaction'); await complete(calls.at(-1)!)
await click('signOnDevice'); const secondSign = calls.at(-1)!
await complete(firstSign, 'retired signature')
expect(text()).not.toContain('transactionSigned'); expect(button('confirmOnDevice').disabled).toBe(true)
await complete(secondSign, 'current signature'); expect(text()).toContain('current signature'); expect(text()).not.toContain('retired signature')
expect(calls.filter(call => call.method === 'broadcastTx')).toHaveLength(0)
summary.retiredSignature = true
await unmount()

for (const patch of [{ address: otherOwner, evmAddressIndex: 1 }, { token }]) {
  await mount(); await fill(); await click('buildTransaction'); await complete(calls.at(-1)!)
  await click('signOnDevice'); const pending = calls.at(-1)!
  await render(patch); await complete(pending, 'signature for retired owner or asset')
  expect(text()).not.toContain('transactionSigned'); expect(button('broadcastTransaction')).toBeUndefined()
  expect(calls.filter(call => call.method === 'broadcastTx')).toHaveLength(0)
  await unmount()
}
summary.signingIdentities = 2

// Background balance pushes retain drafts/reviews and cannot rewrite signed metadata.
await mount(); await fill(); await render({ balance: { ...balance, balanceUsd: 20000 }, balanceLoading: true })
expect(input('amountPlaceholder').value).toBe('1'); expect(input('addressPlaceholder').value).toBe(recipient)
await click('max'); await click('buildTransaction'); await complete(calls.at(-1)!)
await click('signOnDevice'); await complete(calls.at(-1)!, 'signed maximum')
await render({ balance: { ...balance, balance: '20', balanceUsd: 20000 } }); expect(text()).toContain('transactionSigned')
await click('broadcastTransaction'); const broadcast = calls.at(-1)!
expect(broadcast.params).toMatchObject({ to: recipient, amount: '9', fromAddress: owner, chainId: 'ethereum' })
await complete(broadcast, { txid: 'synthetic-transaction-id' }); summary.snapshot = true
await unmount()

await mount(); await fill(); await click('buildTransaction'); const abandoned = calls.at(-1)!
await unmount(); await complete(abandoned); await mount(); expect(ready()).toBe(false)
expect(calls).toHaveLength(0); summary.unmounted = true
await unmount()

// Unknown/pending is neutral; a known balance stays visible while refreshing.
await mount({ balance: undefined, balanceLoading: true })
expect(container.querySelector('[aria-label="Refreshing balance"]')).not.toBeNull()
expect(text()).toContain('—'); expect(button('max').disabled).toBe(true)
expect(text()).not.toContain('Low'); expect(text()).not.toContain('unavailable')
await render({ balance, balanceLoading: false }); expect(button('max').disabled).toBe(false)
expect(container.querySelector('[aria-label="Refreshing balance"]')).toBeNull()
await fill(); await render({ balanceLoading: true })
expect(text()).toContain('10'); expect(input('amountPlaceholder').value).toBe('1'); expect(button('max').disabled).toBe(false)
summary.pendingBalance = true
await unmount()
console.log(JSON.stringify(summary))
