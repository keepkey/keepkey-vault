// The real AddAddressDialog on Zcash, with the real validator (Jasper audit v5 V8).
// No device, network, or wallet storage.
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
import * as React from 'react'
import { bech32, bech32m, createBase58check } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2'
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
const saved: any[] = []
mock.module('../../src/mainview/lib/rpc', () => ({ rpcRequest: async (method: string, params: any) => {
  if (method === 'matchAddress') return null
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
// Pick Zcash (the visible chain; zcash-shielded is hidden but shares its networkId).
await click(buttons()[0])
await click(buttons().find(b => /Zcash/.test(b.textContent || ''))!)
const input = () => container.querySelectorAll('input')[0] as HTMLInputElement
const type = async (value: string) => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input(), value); input().dispatchEvent(new Event('input', { bubbles: true })) })
  await settle(350) // past the own-address lookup debounce
}
const addButton = () => buttons().find(b => b.textContent === 'addAddress')!
const ERRORS = ['invalidZecAddress', 'invalidZcashShieldedAddress', 'invalidChecksum', 'burnAddress']
const sapling = bech32.encode('zs', bech32.toWords(Uint8Array.from({ length: 43 }, (_, i) => i)), false)
const unified = bech32m.encode('u', bech32m.toWords(Uint8Array.from({ length: 107 }, (_, i) => (i * 7) & 0xff)), false)
const transparent = createBase58check(sha256).encode(Uint8Array.from([0x1c, 0xb8, ...Array.from({ length: 20 }, (_, i) => i + 1)]))
const out: Record<string, any> = {}
for (const [name, addr] of [
  ['transparent', transparent],
  ['sapling', sapling],
  ['unified', unified],
  ['saplingTypo', sapling.slice(0, 20) + (sapling[20] === 'q' ? 'p' : 'q') + sapling.slice(21)],
  ['garbage', 'zs1notanaddress'],
] as const) {
  await type(addr)
  const text = container.textContent || ''
  out[name] = { canAdd: !addButton().disabled, error: ERRORS.find(k => text.includes(k)) ?? null }
}
await type(unified)
await click(addButton())
await settle()
out.saved = saved.map(s => ({ networkId: s.networkId, shielded: s.address === unified }))
await act(async () => root.unmount())
console.log(JSON.stringify(out))
process.exit(0)
