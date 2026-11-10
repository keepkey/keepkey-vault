import { JSDOM } from 'jsdom'
import { expect, mock } from 'bun:test'
import * as React from 'react'
const dom = new JSDOM('<!doctype html><html><body></body></html>')
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const listeners = new Set<() => void>()
const media = { matches: false, addEventListener: (_: string, listener: () => void) => listeners.add(listener),
  removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) }
window.matchMedia = (() => media) as any
const node = (tag: string) => (props: any) => React.createElement(tag,
  Object.fromEntries(Object.entries(props).filter(([key]) => ['src', 'alt', 'onError'].includes(key))), props.children)
mock.module('@chakra-ui/react', () => ({ Box: node('div'), Text: node('span'), Image: node('img') }))
mock.module('../../src/shared/assetLookup', () => ({
  getAssetIcon: (caip: string) => `views://main/networks/${caip}.png`,
  caipToIcon: (caip: string) => `views://main/networks/${caip}.png`, isBundledAssetIcon: () => true,
}))
globalThis.fetch = (() => { throw new Error('RouteMap fixture must not access the network') }) as typeof fetch
const { act } = React
const { createRoot } = await import('react-dom/client')
const { RouteMap } = await import('../../src/mainview/components/v3/RouteMap')
const from = { iconUrl: 'views://main/assets/eth.svg', caip: 'eip155:1/erc20:test', chainCaip: 'eip155:1/slip44:60', glyph: 'ETH', color: 'blue' }
const to = { iconUrl: 'views://main/assets/btc.png', caip: 'bitcoin-native', chainCaip: 'bitcoin-native', glyph: 'BTC', color: 'orange' }
let props = { from, to, integration: 'THORChain', showIntegrationLabel: undefined as boolean | undefined, centerImageUrl: 'views://main/assets/calculating.gif', animate: true }
const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const render = async () => { await act(async () => root.render(<><RouteMap {...props} /><RouteMap {...props} /></>)) }
const image = (src: string) => [...container.querySelectorAll('img')].find(node => node.getAttribute('src') === src)
const integrationLabels = () => [...container.querySelectorAll('svg text')].filter(node => node.textContent === 'THORCHAIN')
await render()
expect(integrationLabels()).toHaveLength(2)
expect(container.querySelectorAll('svg image')).toHaveLength(0)
expect(image(from.iconUrl)?.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
expect(image(from.iconUrl)?.parentElement?.localName).toBe('foreignObject')
expect(image(props.centerImageUrl)).toBeDefined()
expect(container.querySelectorAll('animateMotion')).toHaveLength(2)
expect(container.querySelectorAll('foreignObject')).toHaveLength(8) // 3 images + one network badge per route.
const gradientIds = [...container.querySelectorAll('linearGradient')].map(node => node.id)
expect(new Set(gradientIds).size).toBe(2)
for (const [index, svg] of [...container.querySelectorAll('svg')].entries()) {
  expect(svg.querySelector('path[opacity="0.7"]')?.getAttribute('stroke')).toBe(`url(#${gradientIds[index]})`)
}
await act(async () => image(from.iconUrl)!.dispatchEvent(new window.Event('error')))
expect(container.querySelector('svg')?.textContent).toContain('ETH')
expect(!!container.querySelector('svg')?.querySelector('img[src="views://main/assets/eth.svg"]')).toBe(false)
await act(async () => image(props.centerImageUrl)!.dispatchEvent(new window.Event('error')))
expect(container.querySelector('svg')?.textContent).toContain('THO')
props = { ...props, showIntegrationLabel: false }; await render()
expect(integrationLabels()).toHaveLength(0)
expect(container.querySelector('svg')?.textContent).toContain('THO') // The fallback glyph remains.
props = { ...props, showIntegrationLabel: undefined }; await render()
expect(integrationLabels()).toHaveLength(2)
// A replacement source recovers immediately; revisiting a known failed URL stays a glyph.
props = { ...props, from: { ...from, iconUrl: 'views://main/assets/replacement.svg' }, centerImageUrl: 'views://main/assets/replacement.gif' }
await render(); expect(image(props.from.iconUrl)).toBeDefined(); expect(image(props.centerImageUrl)).toBeDefined()
expect([...container.querySelectorAll('linearGradient')].map(node => node.id)).toEqual(gradientIds)
props = { ...props, from, centerImageUrl: 'views://main/assets/calculating.gif' }; await render()
expect(!!container.querySelector('svg')?.querySelector('img[src="views://main/assets/eth.svg"]')).toBe(false)
expect(!!container.querySelector('svg')?.querySelector('img[src="views://main/assets/calculating.gif"]')).toBe(false)
props = { ...props, centerImageUrl: 'views://main/assets/replacement.gif' }; await render()
await act(async () => { media.matches = true; for (const listener of listeners) listener() })
expect(container.querySelectorAll('animateMotion')).toHaveLength(0)
expect(!!image(props.centerImageUrl)).toBe(false); expect(container.textContent).toContain('THO')
await act(async () => { media.matches = false; for (const listener of listeners) listener() })
expect(container.querySelectorAll('animateMotion')).toHaveLength(2); expect(image(props.centerImageUrl)).toBeDefined()
props = { ...props, animate: false }; await render()
expect(container.querySelectorAll('animateMotion')).toHaveLength(0); expect(image(props.centerImageUrl)).toBeDefined()
await act(async () => root.unmount())
expect(listeners.size).toBe(0)
// Respect reduced motion at first paint, before any GIF appears in the DOM.
media.matches = true
const reducedRoot = createRoot(container)
await act(async () => reducedRoot.render(<RouteMap {...props} animate />))
expect(container.querySelectorAll('animateMotion')).toHaveLength(0); expect(!!image(props.centerImageUrl)).toBe(false)
await act(async () => reducedRoot.unmount()); expect(listeners.size).toBe(0)
console.log(JSON.stringify({ htmlIcons: true, badges: true, uniqueGradients: true, imageFallbacks: true, reducedMotion: true }))
