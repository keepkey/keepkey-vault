// The actual activity row and detail dialog for an unsent signature; RPCs stay
// in a local recorder. No backend, device, network or user-data storage.
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
import * as React from 'react'
import type { RecentActivity } from '../../src/shared/types'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const element = (tag: string) => ({ as, children, ...props }: any) => {
  const attrs = Object.fromEntries(Object.entries(props).filter(([key]) => /^(on[A-Z]|aria-|data-)/.test(key)
    || ['disabled', 'title', 'role', 'type', 'src', 'alt'].includes(key)))
  return React.createElement(as || tag, attrs, children)
}
mock.module('@chakra-ui/react', () => ({ Box: element('div'), Flex: element('div'), Text: element('span'),
  VStack: element('div'), HStack: element('div'), Image: element('img'), Button: element('button') }))
mock.module('../../src/mainview/i18n', () => ({ default: { resolvedLanguage: 'en', language: 'en' } }))
mock.module('../../src/mainview/i18n/ui', () => ({ useUiTranslation: () => (text: string) => text }))
mock.module('../../src/mainview/lib/number-locale', () => ({ getNumberLocale: () => 'en-US' }))
mock.module('../../src/mainview/components/DocsLink', () => ({ DocsLink: () => null }))
mock.module('../../src/shared/assetLookup', () => ({ caipToIcon: () => '' }))
const calls: Array<{ method: string; params: unknown }> = []
mock.module('../../src/mainview/lib/rpc', () => ({ rpcRequest: async (method: string, params: unknown) => { calls.push({ method, params }) } }))
globalThis.fetch = (() => { throw new Error('Network forbidden in activity fixture') }) as typeof fetch

const { act } = React
const { createRoot } = await import('react-dom/client')
const { ActivityRow, TxDetailDialog } = await import('../../src/mainview/components/ActivityPanel')
const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const base: RecentActivity = { id: '42', chain: 'ETH', chainId: 'ethereum', type: 'sign', source: 'api', appName: 'fixture-dapp',
  status: 'not_sent', createdAt: Date.now() - 11 * 24 * 60 * 60 * 1000 }
const text = () => container.textContent || ''
const discard = () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Discard')
const result: Record<string, unknown> = {}

await act(async () => root.render(<ActivityRow activity={base} nativePrices={{}} onSelect={() => {}} />))
result.rowNotSent = text().includes('Not sent')
await act(async () => root.render(<ActivityRow activity={{ ...base, status: 'signed' }} nativePrices={{}} onSelect={() => {}} />))
result.freshRowNotSent = text().includes('Not sent')

let closed = 0
const dialog = async (a: RecentActivity) => act(async () => root.render(<TxDetailDialog detail={{ kind: 'activity', activity: a }} nativePrices={{}} onClose={() => { closed++ }} />))
await dialog(base)
result.dialogNotSent = text().includes('Not sent')
await act(async () => discard()!.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
await act(async () => { await new Promise(r => setTimeout(r, 0)) })
result.discard = { calls: calls.filter(c => c.method === 'dismissActivity'), closed }
await dialog({ ...base, status: 'signed' })
result.freshDiscard = !!discard()
await dialog({ ...base, type: 'send', source: 'scan', status: 'broadcast', txid: '0x' + 'ab'.repeat(32) })
result.broadcastDiscard = !!discard()
await act(async () => root.unmount()); container.remove(); dom.window.close()
console.log(JSON.stringify(result))
