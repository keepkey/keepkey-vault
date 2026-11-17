// Actual dialog and validators, public synthetic addresses, no device/network/profile.
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
import * as React from 'react'
import { bech32, bech32m, createBase58check } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent']) {
  ;(globalThis as any)[key] = (dom.window as any)[key]
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const element = (tag: string) => (props: any) => React.createElement(props.as || tag,
  Object.fromEntries(Object.entries(props).filter(([key]) => /^(on[A-Z]|aria-|data-)/.test(key)
    || ['value', 'disabled', 'placeholder', 'role', 'type', 'checked'].includes(key))), props.children)
mock.module('@chakra-ui/react', () => ({ Box: element('div'), Flex: element('div'), Text: element('span'), Button: element('button'), Input: element('input') }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('../../src/mainview/hooks/useDeviceState', () => ({ useDeviceState: () => ({ isHiddenWallet: false }) }))
mock.module('../../src/mainview/components/AssetIcon', () => ({ AssetIcon: () => null }))
const sapling = bech32.encode('zs', bech32.toWords(Uint8Array.from({ length: 43 }, (_, i) => i)), false)
const unified = bech32m.encode('u', bech32m.toWords(Uint8Array.from({ length: 107 }, (_, i) => (i * 7) & 0xff)), false)
const transparent = createBase58check(sha256).encode(Uint8Array.from([0x1c, 0xb8, ...Array.from({ length: 20 }, (_, i) => i + 1)]))
const own = bech32.encode('zs', bech32.toWords(Uint8Array.from({ length: 43 }, (_, i) => i + 1)), false)
const saved: any[] = []
mock.module('../../src/mainview/lib/rpc', () => ({ rpcRequest: async (method: string, params: any) => {
  if (method === 'matchAddress') return params.address === own ? { kind: 'own', address: own } : null
  if (method === 'addAddressBook') { saved.push(params); return { id: 'synthetic-contact', ...params } }
  throw new Error(`Unexpected RPC: ${method}`)
} }))
globalThis.fetch = (() => { throw new Error('Network forbidden in AddAddressDialog fixture') }) as typeof fetch
const { act } = React
const { createRoot } = await import('react-dom/client')
const { AddAddressDialog } = await import('../../src/mainview/components/AddAddressDialog')
const settle = async (ms = 0) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
let container: HTMLDivElement, root: ReturnType<typeof createRoot>, closedAfterSave = 0, visibleZcashNetworks = 0
const buttons = () => [...container.querySelectorAll('button')]
const click = async (node: Element) => { await act(async () => { (node as HTMLElement).click() }) }
const mount = async () => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  await act(async () => root.render(<AddAddressDialog onClose={() => { closedAfterSave++ }} />))
  await click(buttons()[0])
  const zcash = buttons().filter(button => /Zcash/.test(button.textContent || ''))
  visibleZcashNetworks = zcash.length
  await click(zcash[0])
}
const unmount = async () => { await act(async () => root.unmount()); container.remove() }
const type = async (address: string) => {
  const input = container.querySelectorAll('input')[0]
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, address)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await settle(350)
}
const add = () => buttons().find(button => button.textContent === 'addAddress')!
const errors = ['invalidZecAddress', 'invalidZcashShieldedAddress', 'invalidChecksum', 'burnAddress', 'contactIsOwnAddress']
const out: Record<string, any> = {}
await mount()
for (const [name, address] of [
  ['transparent', transparent], ['sapling', sapling], ['unified', unified],
  ['saplingTypo', sapling.slice(0, 20) + (sapling[20] === 'q' ? 'p' : 'q') + sapling.slice(21)],
  ['unifiedTypo', unified.slice(0, 20) + (unified[20] === 'q' ? 'p' : 'q') + unified.slice(21)],
  ['garbage', 'zs1notanaddress'], ['own', own],
] as const) {
  await type(address)
  out[name] = { canAdd: !add().disabled, error: errors.find(key => container.textContent?.includes(key)) ?? null }
}
await unmount()
for (const address of [transparent, sapling, unified]) {
  await mount(); await type(` ${address} `); await click(add()); await settle(); await unmount()
}
out.visibleZcashNetworks = visibleZcashNetworks
out.saved = saved.map(contact => ({ networkId: contact.networkId,
  format: contact.address === transparent ? 'transparent' : contact.address === sapling ? 'sapling' : contact.address === unified ? 'unified' : 'unexpected',
  cosigner: contact.cosigner === true,
}))
out.closedAfterSave = closedAfterSave
console.log(JSON.stringify(out))
process.exit(0)
