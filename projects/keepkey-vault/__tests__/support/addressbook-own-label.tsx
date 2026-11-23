/** Actual AddressBookView/AddressBookPicker with the real i18n catalogs: the stored
 *  English default own label ("My RUNE") follows the language in search and edit. */
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'localStorage']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(window as any).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
const { act } = React

const now = Date.now()
const entry = {
  id: 'own-rune', walletId: 'w', deviceId: 'dev-1', kind: 'own', networkId: 'cosmos:thorchain-1', chainId: 'thorchain',
  address: 'thor1ownaddressfixture', label: 'My RUNE', createdAt: now, updatedAt: now,
}
const saved: any[] = []
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: async (method: string) => {
    if (method === 'listAddressBook') return [entry]
    if (method === 'getAppSettings') return {}
    return new Promise(() => {})
  },
  onRpcMessage: () => () => {},
}))
mock.module('../../src/mainview/hooks/useAddressBook', () => ({ useAddressBook: () => ({
  entries: [entry], loading: false, seeding: false,
  saveLabel: async (...args: any[]) => { saved.push(args) }, setCosigner: async () => {}, remove: async () => {},
}) }))
mock.module('../../src/mainview/hooks/useDeviceState', () => ({ useDeviceState: () => ({ state: 'ready', deviceId: 'dev-1', firmwareVersion: '7.17.0' }) }))

const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
const i18n = (await import('../../src/mainview/i18n')).default
const { AddressBookView } = await import('../../src/mainview/components/AddressBookView')
const { AddressBookPicker } = await import('../../src/mainview/components/AddressBookPicker')
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }) }
const typeInto = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true })) })
}
const click = async (el: Element | null | undefined) => { if (!el) throw new Error('missing element'); await act(async () => { (el as HTMLElement).click() }) }
const byText = (root: Element, text: string) => [...root.querySelectorAll('button, p, span')].find(el => el.textContent?.trim() === text)

const result: any = {}
const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
try {
  await act(async () => { await i18n.changeLanguage('en') })
  // Picker search: rendered in English, then the language switches to pt.
  await act(async () => root.render(<ChakraProvider value={defaultSystem}><AddressBookPicker networkId="cosmos:thorchain-1" chainFamily="cosmos" onSelect={() => {}} onClose={() => {}} /></ChakraProvider>))
  await settle()
  // The search is already typed when the language switches: only `t` changes.
  await typeInto(container.querySelector('input')!, 'meu')
  await settle()
  await act(async () => { await i18n.changeLanguage('pt') })
  await settle()
  result.pickerFindsTranslated = container.textContent?.includes('Meu RUNE') ?? false

  // Edit field in pt.
  await act(async () => root.render(<ChakraProvider value={defaultSystem}><AddressBookView /></ChakraProvider>))
  await settle()
  // Own entries live under their device's tab.
  await click(byText(container, 'dev-1')?.closest('button'))
  await settle()
  await click(byText(container, 'Meu RUNE')?.closest('button'))
  await settle()
  await click(byText(container, String(i18n.t('edit', { ns: 'addressbook' }))))
  await settle()
  const input = [...container.querySelectorAll('input')].find(i => i.value.includes('RUNE')) as HTMLInputElement | undefined
  result.editPrefill = input?.value ?? null
  await click(byText(container, String(i18n.t('save', { ns: 'common' }))))
  await settle()
  result.savedUnchanged = saved.length
  await click(byText(container, String(i18n.t('edit', { ns: 'addressbook' }))))
  await settle()
  const input2 = [...container.querySelectorAll('input')].find(i => i.value.includes('RUNE')) as HTMLInputElement
  await typeInto(input2, 'Cofre RUNE')
  await click(byText(container, String(i18n.t('save', { ns: 'common' }))))
  await settle()
  result.savedEdited = saved.map(args => args[1])
  await act(async () => root.unmount())
} finally { container.remove(); dom.window.close() }
console.log(JSON.stringify(result))
