// The real AddAddressDialog with the real validator. No device, network, or wallet storage.
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
import * as React from 'react'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const element = (tag: string) => (props: any) => {
  const attrs = Object.fromEntries(Object.entries(props).filter(([key]) => /^(on[A-Z]|aria-|data-)/.test(key)
    || ['value', 'disabled', 'placeholder', 'role', 'type', 'checked'].includes(key)))
  return React.createElement(props.as || tag, attrs, props.children)
}
mock.module('@chakra-ui/react', () => ({ Box: element('div'), Flex: element('div'), Text: element('span'), Button: element('button'), Input: element('input') }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('../../src/mainview/hooks/useDeviceState', () => ({ useDeviceState: () => ({ isHiddenWallet: false }) }))
mock.module('../../src/mainview/components/AssetIcon', () => ({ AssetIcon: () => null }))
const OWN = '0x9768236c72F2EddE1A46aff6c1D85f5E252E6183'
const saved: any[] = []
mock.module('../../src/mainview/lib/rpc', () => ({ rpcRequest: async (method: string, params: any) => {
  if (method === 'matchAddress') return params.address.toLowerCase() === OWN.toLowerCase() ? { address: OWN, kind: 'own' } : null
  if (method === 'addAddressBook') { saved.push(params); return { id: 'x', ...params } }
  throw new Error(`Unexpected RPC: ${method}`)
} }))
globalThis.fetch = (() => { throw new Error('Network forbidden in AddAddressDialog fixture') }) as typeof fetch

const { act } = React
const { createRoot } = await import('react-dom/client')
const { AddAddressDialog } = await import('../../src/mainview/components/AddAddressDialog')
const settle = async (ms = 0) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }

const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
await act(async () => root.render(<AddAddressDialog onClose={() => {}} />))
const buttons = () => [...container.querySelectorAll('button')]
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }
// Pick Base.
await click(buttons()[0])
await click(buttons().find(b => b.textContent?.includes('Base'))!)
const input = () => container.querySelectorAll('input')[0] as HTMLInputElement
const type = async (value: string) => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input(), value); input().dispatchEvent(new Event('input', { bubbles: true })) })
  await settle(350) // past the own-address lookup debounce
}
const state = () => ({
  text: container.textContent || '',
  canAdd: !buttons().find(b => b.textContent === 'addAddress')!.disabled,
  cosigner: !!container.querySelector('input[type="checkbox"]'),
})
const out: Record<string, any> = {}
for (const [name, addr] of [
  ['badChecksum', '0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
  ['ens', 'vitalik.eth'],
  ['zero', '0x0000000000000000000000000000000000000000'],
  ['burn', '0x000000000000000000000000000000000000dEaD'],
  ['own', OWN],
  ['valid', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
] as const) {
  await type(addr)
  const s = state()
  out[name] = { canAdd: s.canAdd, cosigner: s.cosigner, error: ['invalidEvmChecksum', 'ensNotSupported', 'burnAddress', 'contactIsOwnAddress'].find(k => s.text.includes(k)) ?? null }
}
await click(buttons().find(b => b.textContent === 'addAddress')!)
await settle()
out.saved = saved.map(s => s.address)
await act(async () => root.unmount())
console.log(JSON.stringify(out))
process.exit(0)
