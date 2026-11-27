/** Actual AddressBookView in Portuguese, with one device whose name is long (KEEPKEY-180):
 *  the "Saved recipients" tab shows its whole label, a device tab is cut at 140px and
 *  gives its full name on hover. */
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
const deviceName = 'KeepKey do escritório com nome comprido'
const entries = [{
  id: 'own-btc', walletId: 'w', deviceId: 'dev-1', deviceLabel: deviceName, kind: 'own', networkId: 'bip122:000000000019d6689c085ae165831e93',
  chainId: 'bitcoin', address: 'bc1qownaddressfixture0000000000000000000000', label: 'My BTC', createdAt: now, updatedAt: now,
}]
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: async (method: string) => method === 'getAppSettings' ? {} : new Promise(() => {}),
  onRpcMessage: () => () => {},
}))
mock.module('../../src/mainview/hooks/useAddressBook', () => ({ useAddressBook: () => ({
  entries, loading: false, seeding: false, saveLabel: async () => {}, setCosigner: async () => {}, remove: async () => {},
}) }))
mock.module('../../src/mainview/hooks/useDeviceState', () => ({ useDeviceState: () => ({ state: 'ready', deviceId: 'dev-1', firmwareVersion: '7.17.0' }) }))

const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
const i18n = (await import('../../src/mainview/i18n')).default
const { AddressBookView } = await import('../../src/mainview/components/AddressBookView')
const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const result: any = {}
try {
  await act(async () => { await i18n.changeLanguage('pt') })
  await act(async () => root.render(<ChakraProvider value={defaultSystem}><AddressBookView /></ChakraProvider>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  const labels = Array.from(container.querySelectorAll<HTMLElement>('button p'))
  const tab = (text: string) => labels.find(el => el.textContent === text)
  const style = (el?: HTMLElement) => el ? getComputedStyle(el) : null
  const saved = tab('Destinatários salvos')
  const device = tab(deviceName)
  // The raw computed values: an empty maxWidth / textOverflow means no limit and no ellipsis.
  const read = (el?: HTMLElement) => el ? { maxWidth: style(el)!.maxWidth, textOverflow: style(el)!.textOverflow, title: el.title } : null
  result.savedTab = read(saved)
  result.deviceTab = read(device)
  await act(async () => root.unmount())
} finally { container.remove(); dom.window.close() }
console.log(JSON.stringify(result))
