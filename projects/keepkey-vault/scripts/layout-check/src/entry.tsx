import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { system } from '../../../src/mainview/theme'
import '../../../src/mainview/index.css'
import '../../../src/mainview/styles/tokens.css'
import '../../../src/mainview/i18n'
import { SwapDialog } from '../../../src/mainview/components/SwapDialog'
import { MagiSwapDialog } from '../../../src/mainview/components/MagiSwapDialog'
import { AssetPickerDialog } from '../../../src/mainview/components/AssetPickerDialog'
import { PairingApproval } from '../../../src/mainview/components/device/PairingApproval'
import { rpcRequest, ASSETS, ethEth, baseEth } from './fake-rpc'

const w = window as any
/** Any bundled square icon stands in for an app's own. */
const PAIRING_ICON = '0520f602bb269107e002d011.png'
const mode = new URLSearchParams(location.search).get('mode') || 'form'
document.body.style.background = '#000'
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (f: () => boolean, ms = 8000) => { for (const t = Date.now(); !f() && Date.now() - t < ms;) await wait(50) }
const cmd = (c: any) => w.__listeners['swap-cmd']?.(c)

function Picker({ side }: { side: 'from' | 'to' }) {
  const [balances, setBalances] = useState<any[]>([])
  useEffect(() => { rpcRequest('getBalances').then(setBalances) }, [])
  // The SwapDialog's poll: the same numbers in a new array, every 250 ms.
  useEffect(() => { const t = setInterval(() => setBalances(b => b.map(x => ({ ...x }))), 250); return () => clearInterval(t) }, [])
  w.__pollTicks = (w.__pollTicks || 0)
  return <AssetPickerDialog open onClose={() => {}} swappable={ASSETS as any} balances={balances} side={side}
    excludeCaip={side === 'to' ? ethEth.caip : undefined} onSelect={() => {}} sourceAccountLabel={side === 'from' ? 'EVM · Account #0 · 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' : undefined} />
}

function App() {
  if (mode.startsWith('picker-from')) return <Picker side="from" />
  if (mode.startsWith('picker-to')) return <Picker side="to" />
  if (mode === 'magi') return <MagiSwapDialog open onClose={() => {}} initialFrom="HIVE" onSendBtc={() => {}} />
  // An extension with no icon (the Skate Wallet case) and a site that sends one.
  if (mode === 'pairing-ext') return <PairingApproval request={{ name: 'Skate Wallet', url: 'chrome-extension://iilbclbaojnjbeokklgbakballmfppnm/', imageUrl: '' }} onApprove={() => {}} onReject={() => {}} />
  if (mode === 'pairing-web') return <PairingApproval request={{ name: 'swaps.pro', url: 'https://swaps.pro/app', imageUrl: 'assets/token-icons/' + PAIRING_ICON }} onApprove={() => {}} onReject={() => {}} />
  return <SwapDialog open onClose={() => {}} />
}
createRoot(document.getElementById('root')!).render(<ChakraProvider value={system}><App /></ChakraProvider>)

// Drive the state, then flag readiness for the probe.
;(async () => {
  const click = (sel: string | Element | null | undefined) => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel; (el as HTMLElement | null)?.click() }
  const byText = (re: RegExp) => [...document.querySelectorAll('button')].find(b => re.test((b.textContent || '').trim()))
  if (['form', 'review', 'signing', 'route-details', 'health'].includes(mode)) {
    await until(() => !!w.__listeners['swap-cmd'])
    await wait(200)
    cmd({ kind: 'set', fromAssetDefinition: ethEth, fromAsset: ethEth.asset, toAssetDefinition: baseEth, toAsset: baseEth.asset, amount: '0.01', inputMode: 'crypto', useCustomAddress: false, customToAddress: '' })
    await until(() => !!w.__swapState?.quote?.quoteId && w.__swapState.phase === 'input')
    await wait(400)
    if (mode === 'route-details') { click(byText(/NEAR Intents/)); await wait(400) }
    if (mode === 'health') { click(document.querySelector('[data-swap-panel] .kk-pf-kicker')?.parentElement?.querySelector('button')); await wait(400) }
    if (mode === 'review' || mode === 'signing') {
      click(byText(/^Review swap$/))
      await until(() => w.__swapState?.phase === 'review' && !!w.__swapState?.previewBuild?.unsignedTx)
      await wait(400)
    }
    if (mode === 'signing') {
      click(byText(/^Swap on KeepKey$/))
      await until(() => !!document.querySelector('[data-swap-signing]'))
      w.__listeners['swap-substage']?.({ stage: 'swap-signing', tx: { chainId: 1, to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', value: '0x2386f26fc10000', data: '0x', gasLimit: '0x5208', maxFeePerGas: '0x6fc23ac00', clearSign: false } })
      await wait(300)
    }
  }
  if (mode.startsWith('picker')) {
    await until(() => !!document.querySelector('[data-picker-row]'))
    await wait(300)
    if (mode === 'picker-to-asset' || mode === 'picker-to-confirm' || mode === 'picker-to-unavailable') {
      click('[data-network="eip155:8453"]'); await wait(300)
      if (mode === 'picker-to-confirm') { click('[data-picker-row]'); await wait(300) }
    }
    if (mode === 'picker-from-confirm') { click('[data-picker-row]'); await wait(300) }
    if (mode === 'picker-from-empty') { const i = document.querySelector('.kk-ap-bar input') as HTMLInputElement; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; set.call(i, 'zzzz'); i.dispatchEvent(new Event('input', { bubbles: true })); await wait(300) }
    // Flicker watch: rows removed from the DOM and "Loading" shown while the poll runs.
    w.__rowRemovals = 0; w.__loadingSeen = 0; w.__imgLoads = 0
    new MutationObserver(ms => { for (const m of ms) for (const n of m.removedNodes) if (n instanceof Element && (n.matches('li') || n.querySelector?.('[data-picker-row]'))) w.__rowRemovals++
      if (/Loading…/.test(document.querySelector('.kk-ap')?.textContent || '')) w.__loadingSeen++ }).observe(document.body, { childList: true, subtree: true })
    document.addEventListener('load', e => { if ((e.target as Element).tagName === 'IMG') w.__imgLoads++ }, true)
    await wait(2000) // 8 poll ticks
  }
  if (mode.startsWith('pairing')) await wait(800)
  if (mode === 'magi') { await until(() => !!document.querySelector('[data-magi-swap] .kk-pf')); const i = document.querySelector('[data-magi-swap] input') as HTMLInputElement; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; set.call(i, '10'); i.dispatchEvent(new Event('input', { bubbles: true })); await wait(1500) }
  w.__ready = true
})()
