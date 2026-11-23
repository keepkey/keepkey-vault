/** Actual AddressBookView with recipients on two different chains: no network filter is offered,
 *  and every recipient shows. */
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
const external = (id: string, networkId: string, chainId: string, address: string, label: string) =>
  ({ id, walletId: 'w', deviceId: 'dev-1', kind: 'external', networkId, chainId, address, label, savedAt: now, createdAt: now, updatedAt: now })
const entries = [
  external('btc-friend', 'bip122:000000000019d6689c085ae165831e93', 'bitcoin', 'bc1qfriendfixture00000000000000000000000000', 'Friend BTC'),
  external('eth-friend', 'eip155:1', 'ethereum', '0x1111111111111111111111111111111111111111', 'Friend ETH'),
]
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
  await act(async () => { await i18n.changeLanguage('en') })
  await act(async () => root.render(<ChakraProvider value={defaultSystem}><AddressBookView /></ChakraProvider>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  const text = container.textContent || ''
  result.offersNetworkFilter = text.includes('All networks')
  result.showsEveryRecipient = text.includes('Friend BTC') && text.includes('Friend ETH')
  await act(async () => root.unmount())
} finally { container.remove(); dom.window.close() }
console.log(JSON.stringify(result))
