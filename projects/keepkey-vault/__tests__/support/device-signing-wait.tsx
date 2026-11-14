// Real Staking and Name registration panels with deferred RPCs. No device, network, or wallet storage.
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
  return React.createElement(typeof props.as === 'function' ? 'span' : props.as || tag, attrs, props.children)
}
mock.module('@chakra-ui/react', () => ({ Box: element('div'), Flex: element('div'), Text: element('span'), VStack: element('div'),
  HStack: element('div'), Button: element('button'), IconButton: element('button'), Input: element('input'), Spinner: element('span'), Badge: element('span') }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }))
mock.module('../../src/mainview/i18n/ui', () => ({ useUiTranslation: () => translate }))
mock.module('../../src/mainview/lib/fiat-context', () => ({ useFiat: () => ({ locale: 'en-US', fmt: String, fmtCompact: String }) }))
mock.module('../../src/mainview/lib/signing-errors', () => ({ describeSigningError: (error: Error) => error.message }))

function deferred() {
  let resolve!: (value: any) => void, reject!: (error: Error) => void
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const calls: Array<{ method: string; timeout?: number; pending: ReturnType<typeof deferred> }> = []
const SIGNERS = ['cosmosSignTx', 'thorchainSignTx']
mock.module('../../src/mainview/lib/rpc', () => ({ rpcRequest: async (method: string, _params: any, timeout?: number) => {
  calls.push({ method, timeout, pending: deferred() })
  if (method === 'getStakingPositions') return []
  if (method === 'getNameQuote') return { registerFeeBase: '1000000000', feePerBlockBase: '2', blocksPerYear: 5256000, currentBlockHeight: 1 }
  if (method === 'lookupName') return { found: false, name: 'fixture' }
  if (method === 'buildDelegateTx' || method === 'buildNameRegistrationTx') return { unsignedTx: { fixture: 'transaction' }, fee: '0' }
  if (method === 'cancelForegroundDeviceOperation') {
    // Bun aborts the Desktop operation; the waiting sign rejects with its 499.
    calls.findLast(call => SIGNERS.includes(call.method))?.pending.reject(new Error('KeepKey request cancelled'))
    return { ok: true }
  }
  if (SIGNERS.includes(method)) return calls.at(-1)!.pending.promise
  throw new Error(`Unexpected RPC: ${method}`)
} }))
globalThis.fetch = (() => { throw new Error('Network forbidden in device signing fixture') }) as typeof fetch

const { act } = React
const { createRoot } = await import('react-dom/client')
const { CHAINS } = await import('../../src/shared/chains')
const { StakingPanel } = await import('../../src/mainview/components/StakingPanel')
const { NameRegistrationPanel } = await import('../../src/mainview/components/NameRegistrationPanel')
const settle = async (ms = 0) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
const mount = async (node: React.ReactNode) => {
  calls.length = 0
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  await act(async () => root.render(node)); await settle()
}
const unmount = async () => { await act(async () => root.unmount()); container.remove() }
const text = () => container.textContent || ''
const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label)!
const click = async (label: string) => { expect(button(label)).toBeDefined(); expect(button(label).disabled).toBe(false)
  await act(async () => button(label).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))); await settle() }
const setInput = async (selector: string, value: string) => {
  const node = container.querySelector<HTMLInputElement>(selector)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new window.Event('input', { bubbles: true }))
  }); await settle()
}
// Sign waits with no client timeout; Cancel cancels the device prompt and keeps the review.
const waitAndCancel = async (signer: string) => {
  await click('sign')
  const sign = calls.at(-1)!
  expect(sign.method).toBe(signer); expect(sign.timeout).toBe(0)
  expect(text()).toContain('waitingForDevice')
  await click('cancel'); await settle()
  expect(calls.some(call => call.method === 'cancelForegroundDeviceOperation')).toBe(true)
  expect(text()).toContain('KeepKey request cancelled'); expect(text()).not.toContain('waitingForDevice')
  expect(button('sign').disabled).toBe(false)
}
const summary: Record<string, boolean> = {}

const cosmos = CHAINS.find(c => c.id === 'cosmos')!
await mount(<StakingPanel chain={cosmos} address="cosmos1fixture" availableBalance="10" />)
await click('delegate')
await setInput('input[placeholder="cosmosvaloper..."]', 'cosmosvaloper1fixture')
await setInput('input[placeholder="0.00"]', '1')
await click('build')
await waitAndCancel('cosmosSignTx')
summary.staking = true
await unmount()

const thorchain = CHAINS.find(c => c.id === 'thorchain')!
await mount(<NameRegistrationPanel chain={thorchain} address="thor1fixture" availableBalance="100" />)
await setInput('input[placeholder="namePlaceholder"]', 'fixture')
await settle(450) // past the availability lookup debounce
await click('registerButton')
await waitAndCancel('thorchainSignTx')
summary.names = true
await unmount()

console.log(JSON.stringify(summary))
process.exit(0)
