// Real SigningApproval in a short window (the vault opens at 1200×800; the
// webview is shorter than that). jsdom has no layout, so this checks the
// structure the layout relies on: the decision row is never inside a
// scrolling area, the KeepKey sits in the left column in both phases, and the
// step guide folds when the window is short.
import { JSDOM } from 'jsdom'
import { expect, mock } from 'bun:test'
import * as React from 'react'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
// matchMedia for max-height queries, answered from the window height set below.
let viewport = { width: 1100, height: 700 }
;(dom.window as any).matchMedia = (query: string) => {
  const max = /max-height:\s*(\d+)px/.exec(query)
  return { matches: max ? viewport.height <= Number(max[1]) : false, media: query, addEventListener() {}, removeEventListener() {} }
}
const translate = (key: string, fallback?: unknown) => typeof fallback === 'string' ? fallback
  : fallback && typeof fallback === 'object' ? key.replace(/\{\{(\w+)\}\}/g, (_, k) => String((fallback as any)[k] ?? '')) : key
const element = (tag: string) => React.forwardRef<any, any>((props, ref) => {
  const attrs = Object.fromEntries(Object.entries(props).filter(([key]) => /^(on[A-Z]|aria-|data-)/.test(key)
    || ['value', 'disabled', 'checked', 'title', 'role', 'type', 'tabIndex', 'className'].includes(key)))
  return React.createElement(typeof props.as === 'string' ? props.as : tag, { ...attrs, ref }, props.children)
})
mock.module('@chakra-ui/react', () => ({ Box: element('div'), Flex: element('div'), Text: element('span'), VStack: element('div'),
  HStack: element('div'), Button: element('button'), Badge: element('span'), Link: element('a'), Image: element('img') }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }))
mock.module('../../src/mainview/i18n/ui', () => ({ useUiTranslation: () => translate }))
mock.module('../../src/mainview/lib/rpc', () => ({ rpcRequest: async (method: string) => { throw new Error(`Unexpected RPC: ${method}`) } }))
globalThis.fetch = (() => { throw new Error('Network forbidden in signing fixture') }) as typeof fetch
const { createRoot } = await import('react-dom/client')
const { SigningApproval } = await import('../../src/mainview/components/device/SigningApproval')
const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const settle = async () => { await React.act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const noop = () => {}
let n = 0
const render = async (phase: 'approve' | 'device-confirm', devicePrompts = 0) => {
  await React.act(async () => root.render(<SigningApproval key={++n} request={vote} phase={phase} devicePrompts={devicePrompts} onApprove={noop} onReject={noop} onCancel={noop} />))
  await settle()
}
const vote = { id: 'v1', method: '/hive/sign-operations', appName: 'PeakD', appPaired: true,
  rawRequestBody: { operations: [['vote', { voter: 'vladtest', author: 'skatehive', permlink: 'week-47', weight: 10000 }]] } }
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)
/** The decision row: in the pinned footer of the left column, never inside a scrolling area. */
const pinned = (label: string) => {
  const b = button(label)
  expect(b).toBeDefined()
  expect(b!.closest('.kk-pf-scroll')).toBeNull()
  expect(b!.closest('.kk-pf-left.kk-pf-split > .kk-pf-foot')).not.toBeNull()
}
const mirrors = () => [...container.querySelectorAll('[data-device-mirror]')]
const screen = () => [...container.querySelectorAll('[data-oled-screen]')].map(el => [...el.children].map(c => c.textContent).join('|'))
const result: Record<string, boolean> = {}

// The shell: the grid row is clamped to the window so its columns scroll.
await render('approve')
const css = [...container.querySelectorAll('style')].map(s => s.textContent).join('\n')
expect(css).toContain('.kk-pf:not(.kk-pf-flat) { max-height: calc(100vh - 32px); grid-template-rows: minmax(0, 1fr); }')
expect(css).toContain('@media (max-height: 820px)')
expect(css).toContain('.kk-pf-scroll[data-more]')
result.shell = true

// 1. Approve, 1100×700: Reject / Continue pinned; the KeepKey (screen 1 of 3,
//    pills 1..3) in the left column and only there; the step guide folded.
pinned('signing.reject') // the mock translator returns the key
pinned('Continue on KeepKey')
expect(container.querySelector('.kk-pf-left .kk-pf-body')!.contains(button('Continue on KeepKey')!)).toBe(false)
expect(mirrors()).toHaveLength(1)
expect(mirrors()[0]!.closest('.kk-pf-left')).not.toBeNull()
expect(screen()).toEqual(['Vote|@vladtest -> @skatehive at 100.00%'])
expect([...mirrors()[0]!.querySelectorAll('button')].map(b => b.textContent)).toEqual(['1', '2', '3'])
const fold = container.querySelector('details[data-guide-fold]') as HTMLDetailsElement
expect(fold).not.toBeNull()
expect(fold.open).toBe(false)
expect(fold.querySelector('summary')!.textContent).toContain('On your KeepKey')
expect(container.querySelector('.kk-pf-note')!.textContent).toContain('These choices change the app')
result.approveShort = true

// 2. Device confirm, 1280×720: Cancel pinned the same way; the KeepKey follows the device.
viewport = { width: 1280, height: 720 }
await render('device-confirm', 2)
pinned('Cancel')
expect(mirrors()).toHaveLength(1)
expect(mirrors()[0]!.closest('.kk-pf-left')).not.toBeNull()
expect(screen()).toEqual(['Vote Target|week-47'])
result.confirmShort = true

// 3. A tall window keeps the guide open as a timeline, the decision row still pinned.
viewport = { width: 1440, height: 1000 }
await render('approve')
expect(container.querySelector('details[data-guide-fold]')).toBeNull()
expect(container.textContent).toContain('On your KeepKey')
pinned('Continue on KeepKey')
result.approveTall = true

await React.act(async () => root.unmount())
console.log(JSON.stringify(result))
process.exit(0)
