// Shared fixture for the Jasper audit v5 SendForm tests: the real SendForm and address
// validators, deferred RPCs, a captured QR scanner. No device, network or wallet storage.
import { JSDOM } from 'jsdom'
import { expect, mock } from 'bun:test'
import * as React from 'react'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const translate = (key: string) => key
const clickHandlers = new WeakMap<Element, (event: any) => unknown>()
const element = (tag: string) => (props: any) => {
  const attrs = Object.fromEntries(Object.entries(props).filter(([key]) => /^(on[A-Z]|aria-|data-)/.test(key)
    || ['value', 'disabled', 'placeholder', 'title', 'role', 'type', 'checked', 'className'].includes(key)))
  return React.createElement(tag, { ...attrs, ref: tag === 'button' ? (node: Element | null) => {
    if (node && props.onClick) clickHandlers.set(node, props.onClick)
  } : undefined }, props.children)
}
mock.module('@chakra-ui/react', () => ({ Box: element('div'), Flex: element('div'), Text: element('span'),
  VStack: element('div'), Button: element('button'), Input: element('input'), Spinner: element('span') }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }))
mock.module('../../src/mainview/i18n/ui', () => ({ useUiTranslation: () => translate }))
mock.module('../../src/mainview/lib/fiat-context', () => ({ useFiat: () => ({ locale: 'en-US', fmt: String, fmtCompact: String }) }))
mock.module('../../src/mainview/lib/formatting', () => ({ formatBalance: String }))
mock.module('../../src/mainview/lib/signing-errors', () => ({ describeSigningError: (error: Error) => error.message }))
mock.module('../../src/mainview/lib/sounds', () => ({ playSent() {} }))
mock.module('../../src/shared/assetLookup', () => ({ getAsset: () => null }))
export const qr: { onScan: ((data: string) => void) | null } = { onScan: null }
mock.module('../../src/mainview/components/QrScannerOverlay', () => ({ QrScannerOverlay: (p: any) => { qr.onScan = p.onScan; return null } }))
mock.module('../../src/mainview/components/AddressBookPicker', () => ({ AddressBookPicker: () => null }))
mock.module('../../src/mainview/components/AddressIdenticon', () => ({ AddressIdenticon: () => null }))
mock.module('../../src/mainview/components/SaveRecipientDialog', () => ({ SaveRecipientDialog: () => null }))
mock.module('../../src/mainview/components/DocsLink', () => ({ DocsLink: () => null }))

function deferred() {
  let resolve!: (value: any) => void, reject!: (error: Error) => void
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export const calls: Array<{ method: string; params: any; pending: ReturnType<typeof deferred> }> = []
mock.module('../../src/mainview/lib/rpc', () => ({ onRpcMessage: () => () => {}, rpcRequest: async (method: string, params?: any) => {
  if (method === 'checkVaultDestination') return undefined
  if (method === 'matchAddress') return null
  if (method === 'getFees') return { gasPrice: { average: '1', fast: '2' }, unit: 'gwei' }
  if (method === 'isEvmContract') return false
  if (!['buildTx', 'ethSignTx', 'broadcastTx'].includes(method)) throw new Error(`Unexpected RPC: ${method}`)
  const pending = deferred(); calls.push({ method, params, pending }); return pending.promise
} }))
globalThis.fetch = (() => { throw new Error('Network forbidden in SendForm fixture') }) as typeof fetch
const { act } = React
const { createRoot } = await import('react-dom/client')
export const { CHAINS } = await import('../../src/shared/chains')
const { SendForm } = await import('../../src/mainview/components/SendForm')
export const chainById = (id: string) => CHAINS.find(c => c.id === id)!

let props: any, container: HTMLDivElement, root: ReturnType<typeof createRoot>
export const settle = async (ms = 0) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
export const render = async (patch = {}) => { props = { ...props, ...patch }; await act(async () => root.render(<SendForm {...props} />)); await settle() }
/** Mount with `chain`, `address` and `balance` (balance and balanceUsd strings/numbers). */
export const mount = async (patch: Record<string, unknown>) => {
  calls.length = 0; qr.onScan = null
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  props = { evmAddressIndex: 0, ...patch }; await render()
}
export const unmount = async () => { await act(async () => root.unmount()); container.remove() }
export const text = () => container.textContent || ''
export const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label)!
export const input = (placeholder: string) => container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!
export const checkbox = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')
export const query = (selector: string) => container.querySelector<HTMLElement>(selector)
export const dispatchClick = (node: Element) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
export const press = async (node: Element) => { await act(async () => dispatchClick(node)); await settle() }
export const setInput = async (placeholder: string, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input(placeholder), value)
    input(placeholder).dispatchEvent(new window.Event('input', { bubbles: true }))
  }); await settle()
}
export const setRecipient = async (to: string) => { await setInput('addressPlaceholder', to); await settle(340) }
export const click = async (label: string) => { expect(button(label)).toBeDefined(); expect(button(label).disabled).toBe(false); await press(button(label)) }
/** Invoke the real build callback even when the DOM button is disabled. Builds
 * deliberately return deferred RPC promises, so do not await the handler itself. */
export const directBuild = async () => {
  const handler = clickHandlers.get(button('buildTransaction'))
  if (!handler) throw new Error('The current build callback was not rendered')
  await act(async () => { void handler({ preventDefault() {}, stopPropagation() {} }) })
  await settle()
}
/** Open the scanner and feed it a decoded QR payload. */
export const scan = async (data: string) => {
  await press(container.querySelector('button[title="scanQrCode"]')!)
  expect(qr.onScan).not.toBeNull()
  await act(async () => qr.onScan!(data)); await settle(340)
}
export const lastBuild = () => calls.filter(c => c.method === 'buildTx').at(-1)
export const complete = async (call: typeof calls[number], value: any) => { await act(async () => call.pending.resolve(value)); await settle() }
