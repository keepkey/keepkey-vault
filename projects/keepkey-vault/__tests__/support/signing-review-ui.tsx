// Real signing components with layout-only mocks; no device, wallet or network.
import { JSDOM } from 'jsdom'
import { expect, mock } from 'bun:test'
import * as React from 'react'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const translate = (key: string, fallback?: unknown) => typeof fallback === 'string' ? fallback : key
const element = (tag: string) => React.forwardRef<any, any>((props, ref) => {
  const attrs = Object.fromEntries(Object.entries(props).filter(([key]) => /^(on[A-Z]|aria-|data-)/.test(key)
    || ['value', 'disabled', 'checked', 'title', 'role', 'type', 'tabIndex'].includes(key)))
  return React.createElement(typeof props.as === 'string' ? props.as : tag, { ...attrs, ref }, props.children)
})
mock.module('@chakra-ui/react', () => ({ Box: element('div'), Flex: element('div'), Text: element('span'), VStack: element('div'),
  HStack: element('div'), Button: element('button'), Badge: element('span'), Link: element('a') }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }))
mock.module('../../src/mainview/i18n/ui', () => ({ useUiTranslation: () => translate }))
const calls: Array<{ method: string; params: any }> = []
mock.module('../../src/mainview/lib/rpc', () => ({ rpcRequest: async (method: string, params: any) => {
  calls.push({ method, params }); if (method === 'signingReviewFrame') return null
  throw new Error(`Unexpected RPC: ${method}`)
} }))
globalThis.fetch = (() => { throw new Error('Network forbidden in signing review fixture') }) as typeof fetch
const { createRoot } = await import('react-dom/client')
const { SigningApproval } = await import('../../src/mainview/components/device/SigningApproval')
const { SigningReviewOverview } = await import('../../src/mainview/components/device/SigningReviewOverview')
const { SIGNING_REVIEW_EXAMPLES } = await import('../../src/shared/signing-review-examples')
const base = SIGNING_REVIEW_EXAMPLES[0].request
const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const settle = async (ms = 0) => { await React.act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
const render = async (node: React.ReactNode) => { await React.act(async () => root.render(node)); await settle() }
const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label)!
const click = async (label: string) => {
  expect(button(label)).toBeDefined(); expect(button(label).disabled).toBe(false)
  await React.act(async () => button(label).click()); await settle()
}
let approved = 0, rejected = 0, cancelled = 0
const callbacks = { onApprove: () => { approved++ }, onReject: () => { rejected++ }, onCancel: () => { cancelled++ } }
// Simplifying explanations cannot grant consent or dismiss a device warning.
await render(<SigningApproval key="consent" request={{ ...base, requiresBlindSigningConsent: true }} phase="approve" {...callbacks} />)
await click('Essentials'); await click('Larger text')
expect(container.querySelector('[data-review-warning]')).not.toBeNull()
expect(container.querySelector('[data-screen-guide]')).toBeNull()
expect(approved).toBe(0)
const approvalButtons = [...container.querySelectorAll('button')].filter(node => /approve|continue|understand/i.test(node.textContent || ''))
expect(approvalButtons.some(node => node.disabled)).toBe(true)
expect(JSON.parse(window.localStorage.getItem('keepkey.signing-review.v1')!)).toEqual({ depth: 'essentials', largeText: true })
await click('Deep audit'); expect(approved).toBe(0)
// A firmware refusal remains a refusal in all display modes.
await render(<SigningApproval key="refusal" request={{ ...base, firmwareCannotSign: true }} phase="approve" {...callbacks} />)
await click('Essentials')
expect(container.textContent).toContain('cannot sign this request')
expect([...container.querySelectorAll('button')].some(node => /Update firmware|Cannot sign|Firmware update/i.test(node.textContent || '') && node.disabled)).toBe(true)
expect(approved).toBe(0)
// Physical signing never polls a display RPC; Cancel still reaches the owner.
calls.length = 0
await render(<SigningApproval key="physical" request={{ ...base, deviceReview: { emulator: false, deviceId: 'physical' } }} phase="device-confirm" {...callbacks} />)
await settle(220); expect(calls).toHaveLength(0)
expect(container.textContent).toContain('Compare with your KeepKey')
await click('Cancel'); expect(cancelled).toBe(1)
// The active emulator asks for exactly its request/device, then stops on unmount.
await render(<SigningApproval key="emulator" request={{ ...base, id: 'signing-1', deviceReview: { emulator: true, deviceId: 'emulator-1' } }} phase="device-confirm" {...callbacks} />)
expect(calls.length).toBeGreaterThan(0)
expect(calls.every(call => call.method === 'signingReviewFrame' && call.params.signingId === 'signing-1' && call.params.deviceId === 'emulator-1')).toBe(true)
await render(<div />); const after = calls.length; await settle(250); expect(calls).toHaveLength(after)
// The overview has no signing callback and never requests frames or policy changes.
calls.length = 0
await render(<SigningReviewOverview open onClose={() => { rejected++ }} />)
await click('Token allowances'); await click('Essentials')
expect(container.textContent).toContain('unlimited allowance')
await click('Close'); expect(rejected).toBe(1); expect(approved).toBe(0); expect(calls).toHaveLength(0)
await React.act(async () => root.unmount())
console.log(JSON.stringify({ consent: true, refused: true, cancel: true, frames: true, overview: true }))
process.exit(0)
