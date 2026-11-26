// The real PairingApproval with Chakra's provider, in jsdom.
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(window as any).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
await import('../../src/mainview/i18n')
const { PairingApproval } = await import('../../src/mainview/components/device/PairingApproval')

const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
let approved = 0, rejected = 0
const render = async (request: any) => { await act(async () => { root.render(<ChakraProvider value={defaultSystem}><PairingApproval request={request} onApprove={() => approved++} onReject={() => rejected++} /></ChakraProvider>) }) }
const key = async (k: string) => { await act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true })) }) }
const onScreen = () => { const c = container.cloneNode(true) as HTMLElement; c.querySelectorAll('details').forEach(d => d.remove()); return c.textContent || '' }
const result: Record<string, unknown> = {}
try {
  const ext = 'chrome-extension://iilbclbaojnjbeokklgbakballmfppnm/'
  await render({ name: 'Skate Wallet', url: ext, imageUrl: '' })
  result.extensionWarned = !!container.querySelector('[data-pairing-origin="extension"]') && /can’t verify this extension/.test(container.textContent || '')
  result.rawOriginOnlyInDetails = !onScreen().includes('chrome-extension://') && container.querySelector('[data-pairing-tech] [data-pairing-url]')?.textContent === ext
  // No letter disc: the fallback is an outline glyph, no image, no initials.
  const who = container.querySelector('.kk-pf-who')!
  result.glyphNotDisc = !who.querySelector('img') && !!who.querySelector('svg') && !/^S$|^SK$/m.test(who.textContent || '') && (who.textContent || '').includes('Skate Wallet')
  const go = [...container.querySelectorAll('button')].find(b => b.textContent === 'Connect app')
  const no = [...container.querySelectorAll('button')].find(b => b.textContent === 'Decline')
  result.actionsPinned = !!go && !!no && !go.closest('.kk-pf-scroll') && !!go.closest('.kk-pf-foot')
  result.noOldCopy = !/wants to connect to your KeepKey|^Approve$|^Reject$/m.test(container.textContent || '')
  await key('Enter'); result.enterConnects = approved === 1
  await key('Escape'); result.escDeclines = rejected === 1
  await render({ name: 'swaps.pro', url: 'https://swaps.pro', imageUrl: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E' })
  result.webNotWarned = !container.querySelector('[data-pairing-origin]')
  result.iconShown = !!container.querySelector('.kk-pf-who img')
} catch (error: any) {
  result.error = error?.message || String(error)
} finally {
  await act(async () => root.unmount())
}
console.log('PAIRING_RESULT ' + JSON.stringify(result))
process.exit(0)
