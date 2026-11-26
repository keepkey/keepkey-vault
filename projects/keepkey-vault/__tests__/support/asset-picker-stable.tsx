// The real AssetPickerDialog fed the way SwapDialog feeds it: its balance poll
// hands a new array every few seconds, usually with the same numbers. That used
// to rebuild the entry list, show "Loading…" in its place and remount every row
// and logo — the picker flickered.
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(window as any).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
mock.module('../../src/mainview/lib/rpc', () => ({ rpcRequest: async () => [], rpcFire() {}, onRpcMessage: () => () => {} }))
mock.module('../../src/mainview/hooks/useDeviceState', () => ({ useDeviceState: () => ({ firmwareVersion: '7.17.0' }) }))
let builds = 0
const discovery = await import('../../src/shared/swap-discovery')
const realBuild = discovery.buildAssetEntries
mock.module('../../src/shared/swap-discovery', () => ({ ...discovery, buildAssetEntries: async (input: any) => { builds++; return realBuild(input) } }))

const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
await import('../../src/mainview/i18n')
const { AssetPickerDialog, pickerInputsKey } = await import('../../src/mainview/components/AssetPickerDialog')

const owner = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const assets: any[] = [
  { asset: 'ETH.ETH', chainId: 'ethereum', symbol: 'ETH', name: 'Ethereum', chainFamily: 'evm', decimals: 18, caip: 'eip155:1/slip44:60' },
  { asset: 'BASE.ETH', chainId: 'base', symbol: 'ETH', name: 'Ethereum', chainFamily: 'evm', decimals: 18, caip: 'eip155:8453/slip44:60' },
  { asset: 'BTC.BTC', chainId: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', chainFamily: 'utxo', decimals: 8, caip: 'bip122:000000000019d6689c085ae165831e93/slip44:0' },
]
const balances = (eth = '0.5') => [
  { chainId: 'ethereum', symbol: 'ETH', balance: eth, balanceUsd: 1560, nativeBalanceUsd: 1560, address: owner },
  { chainId: 'base', symbol: 'ETH', balance: '0.12', balanceUsd: 374, nativeBalanceUsd: 374, address: owner },
  { chainId: 'bitcoin', symbol: 'BTC', balance: '0.031', balanceUsd: 2900, nativeBalanceUsd: 2900, address: 'bc1q' },
] as any[]

const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const settle = async (ms = 60) => { await act(async () => { await new Promise(r => setTimeout(r, ms)) }) }
const render = async (b: any[]) => { await act(async () => { root.render(<ChakraProvider value={defaultSystem}><AssetPickerDialog open onClose={() => {}} swappable={assets} balances={b} side="from" onSelect={() => {}} /></ChakraProvider>) }); await settle() }
const rows = () => [...container.querySelectorAll('[data-picker-row]')] as HTMLElement[]
const result: Record<string, unknown> = {}
try {
  result.sameKeyForEqualInputs = pickerInputsKey(assets, balances(), [], '7.17.0') === pickerInputsKey([...assets], balances(), [], '7.17.0')
    && pickerInputsKey(assets, balances(), [], '7.17.0') !== pickerInputsKey(assets, balances('0.6'), [], '7.17.0')
  await render(balances())
  for (let i = 0; i < 40 && rows().length === 0; i++) await settle(50)
  result.listShown = rows().length === 3
  const before = rows()
  const buildsBefore = builds
  let removed = 0, loading = 0
  const watch = new MutationObserver(ms => {
    for (const m of ms) for (const n of m.removedNodes) if (n instanceof window.Element && (n.matches('li') || n.querySelector('[data-picker-row]'))) removed++
    if (/Loading…/.test(container.textContent || '')) loading++
  })
  watch.observe(container, { childList: true, subtree: true, characterData: true })
  // Ten poll ticks: new arrays, the same numbers.
  for (let i = 0; i < 10; i++) await render(balances())
  result.pollKeepsRows = removed === 0 && rows().every((r, i) => r === before[i])
  result.pollNeverLoading = loading === 0
  result.pollNoRebuild = builds === buildsBefore
  // A real change: rebuilt, shown in place (same row elements, new amount), never blanked.
  await render(balances('0.75'))
  for (let i = 0; i < 20 && !/0\.75/.test(container.textContent || ''); i++) await settle(50)
  result.realChangeUpdatesInPlace = /0\.75/.test(container.textContent || '') && removed === 0 && loading === 0 && rows().length === 3
  watch.disconnect()
  // Keyboard: ↓ from the search box to the first row, ↓ again to the next.
  const search = container.querySelector('.kk-ap-bar input') as HTMLInputElement
  search.focus()
  await act(async () => { search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  const first = document.activeElement === rows()[0]
  await act(async () => { rows()[0]!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  result.keyboardMoves = first && document.activeElement === rows()[1]
  // One surface; no CAIP on screen (tooltips only); no old tile grid.
  const visible = (container.querySelector('.kk-ap') as HTMLElement).textContent || ''
  result.oneSurfaceNoIds = container.querySelectorAll('.kk-ap').length === 1 && !/eip155:|bip122:|slip44/.test(visible) && rows()[0]!.getAttribute('title')?.includes(':') === true
} catch (error: any) {
  result.error = error?.message || String(error)
} finally {
  await act(async () => root.unmount())
}
console.log('ASSET_PICKER_RESULT ' + JSON.stringify(result))
process.exit(0)
