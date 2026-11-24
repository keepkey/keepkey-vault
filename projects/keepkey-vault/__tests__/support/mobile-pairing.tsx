import { mock } from 'bun:test'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MouseEvent']) (globalThis as any)[key] = (dom.window as any)[key]
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })

const code = 'SAMPLE42'
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: async (method: string) => {
    if (method !== 'generateMobilePairing') throw new Error(method)
    return { code, expiresAt: Date.now() + 900000, expiresIn: 900, qrPayload: JSON.stringify({ code, url: 'https://vault.keepkey.com' }) }
  },
}))
const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
await import('../../src/mainview/i18n')
const { MobilePairingDialog } = await import('../../src/mainview/components/MobilePairingDialog')
const container = document.createElement('div')
document.body.appendChild(container)
const root = createRoot(container)
await act(async () => {
  root.render(<ChakraProvider value={defaultSystem}><MobilePairingDialog open onClose={() => {}} /></ChakraProvider>)
})
const dialog = container.querySelector('[role="dialog"]')!
const displayedCode = [...dialog.querySelectorAll('p')].find(p => p.textContent === code)?.textContent
const svg = dialog.querySelector('svg[shape-rendering="crispEdges"]')!
if (process.env.PAIRING_LAYOUT_HTML) {
  const css = Array.from(document.styleSheets, sheet =>
    Array.from(sheet.cssRules, rule => rule.cssText).join('\n')).join('\n')
  await Bun.write(process.env.PAIRING_LAYOUT_HTML, `<!doctype html><style>${css}</style>${container.innerHTML}
    <script>
      const dialog = document.querySelector('[role="dialog"]')
      const bottom = dialog.lastElementChild
      dialog.scrollTop = dialog.scrollHeight
      const bounds = bottom.getBoundingClientRect()
      const userScrollable = ['auto', 'scroll'].includes(getComputedStyle(dialog).overflowY)
      if (userScrollable && dialog.scrollTop > 0 && bounds.bottom <= innerHeight && bounds.top >= 0)
        document.documentElement.dataset.pairingScroll = 'passed'
    </script>`)
}
console.log(JSON.stringify({ displayedCode, svg: svg.outerHTML, size: Number(svg.getAttribute('width')) }))
await act(async () => root.unmount())
dom.window.close()
