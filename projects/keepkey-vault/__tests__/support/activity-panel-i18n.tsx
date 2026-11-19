/** Actual ActivityPanel pieces rendered in Portuguese: no English labels left (audit v6 U6). */
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'getComputedStyle', 'localStorage']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(window as any).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
const { act } = React
mock.module('../../src/mainview/lib/rpc', () => ({ rpcRequest: () => new Promise(() => {}), onRpcMessage: () => () => {} }))
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
const i18n = (await import('../../src/mainview/i18n')).default
const { TxDetailDialog, ActivityRow } = await import('../../src/mainview/components/ActivityPanel')
const txid = '0x' + 'ab'.repeat(32)
const base = { id: '1', chain: 'ETH', chainId: 'ethereum', createdAt: Date.now(), txid, amount: '1', to: '0x0000000000000000000000000000000000000002' }
const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const render = async (node: any) => {
  await act(async () => root.render(<ChakraProvider value={defaultSystem}>{node}</ChakraProvider>))
  await act(async () => { await new Promise(r => setTimeout(r, 5)) })
  return { text: container.textContent || '', titles: [...container.querySelectorAll('[title]')].map(e => e.getAttribute('title')) }
}
const result: any = {}
try {
  await i18n.changeLanguage('pt')
  result.detail = await render(<TxDetailDialog nativePrices={{}} onClose={() => {}} detail={{ kind: 'activity', activity: { ...base, type: 'send', status: 'completed', source: 'scan', confirmations: 0 } as any }} />)
  result.swapRow = await render(<ActivityRow nativePrices={{}} onSelect={() => {}} activity={{ ...base, type: 'swap', status: 'broadcast', source: 'app', swapStatus: 'output_detected', confirmations: 12 } as any} />)
  result.confirmedRow = await render(<ActivityRow nativePrices={{}} onSelect={() => {}} activity={{ ...base, type: 'receive', status: 'broadcast', source: 'scan', confirmations: 99 } as any} />)
  result.messageRow = await render(<ActivityRow nativePrices={{}} onSelect={() => {}} activity={{ ...base, type: 'message', status: 'signed', source: 'api', txid: undefined } as any} />)
} finally { await act(async () => root.unmount()); container.remove(); dom.window.close() }
console.log(JSON.stringify(result))
