/** Driver for emulator-selection-ui.test.ts: renders the seed picker and the EMU
 * badge in jsdom, clicks them, and prints what a user sees and what was sent.
 * Runs in its own process so the DOM globals stay out of other suites. */
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const g = globalThis as any
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'getComputedStyle', 'localStorage']) {
  g[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
g.window.matchMedia ??= () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
g.IS_REACT_ACT_ENVIRONMENT = true

const React = await import('react')
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
await import('../../src/mainview/i18n/index')
const { EmulatorWalletChooser } = await import('../../src/mainview/components/EmulatorWalletChooser')
const { EmulatorBadgeView, EmulatorBuildOptions } = await import('../../src/mainview/components/EmulatorIdentity')

const SIGNING = '92079869551ab26ccd41d33ede1fe6c69735927e38a3203f932cdb37abe134f7'
const PIN = '249bcff134356ee7' + 'e'.repeat(48)
const builds = [
  { id: PIN, path: '/b/pin', selected: true, version: '7.17.0' },
  { id: SIGNING, path: '/b/sig', selected: false, version: '7.17.0', label: 'Monero signing (research)', research: true, signingEnabled: true },
]
const wallets = [
  { name: 'build-249bcff134356ee7', hasMnemonic: true, isActive: true, label: 'PIN wallet', deviceId: 'emu:aaaaaa' },
  { name: 'build-92079869551ab26c', hasMnemonic: true, isActive: false, isSelected: true, label: 'XMR mainnet', deviceId: 'emu:bbbbbb' },
  { name: 'build-0123456789abcdef', hasMnemonic: false, isActive: false },
  { name: 'my-test-seed', hasMnemonic: true, isActive: false },
]

async function render(element: any) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(React.createElement(ChakraProvider, { value: defaultSystem }, element)) })
  return { container, unmount: () => act(async () => root.unmount()) }
}
const text = (el: Element) => (el.textContent || '').replace(/\s+/g, ' ').trim()
const byLabel = (c: Element, label: string) => c.querySelector(`[aria-label="${label.replace(/"/g, '\\"')}"]`) as HTMLElement | null
async function click(el: Element | null) {
  if (!el) throw new Error('nothing to click')
  await act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
}
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')!.set!
    setter.call(select, value)
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
}

const out: Record<string, unknown> = {}

// ── B1: the picker shows and sets firmware and wallet together ───────────
{
  const picks: Array<[string, string | null | undefined]> = []
  const { container, unmount } = await render(React.createElement(EmulatorWalletChooser, {
    wallets, firmware: { builds, next: { id: PIN, version: '7.17.0', problem: null } },
    onPick: (name: string, buildId?: string | null) => picks.push([name, buildId]), onDelete: () => {}, onClose: () => {},
  }))
  const select = container.querySelector('select[aria-label="Emulator firmware"]') as HTMLSelectElement
  out.firmwareOptions = [...select.options].map(o => o.textContent)
  out.firmwareShown = select.selectedOptions[0]?.textContent
  out.walletTitles = [...container.querySelectorAll('button[title^="Start "]')].map(b => text(b))
  await choose(select, SIGNING)
  await click(byLabel(container, 'Start XMR mainnet on v7.17.0 · Monero signing (research)'))
  await choose(select, '')
  await click(byLabel(container, 'Start my-test-seed on Bundled emulator'))
  out.picks = picks
  await unmount()
}

// An obsolete signing hash is replaced by the reviewed signing version, preserving the wallet.
{
  const picks: unknown[] = []
  const { container, unmount } = await render(React.createElement(EmulatorWalletChooser, {
    wallets, firmware: { builds, next: { id: 'missing-old-hash', problem: 'Missing: /private/path/libkkemu.dylib' } },
    onPick: (name: string, buildId: string | null) => picks.push([name, buildId]), onClose: () => {},
  }))
  out.recommendedVersion = (container.querySelector('select') as HTMLSelectElement).value
  out.recoverySummary = text(container.querySelector('[data-testid="firmware-recovery"]')!)
  await click(byLabel(container, 'Start XMR mainnet on v7.17.0 · Monero signing (research)'))
  out.recommendedPicks = picks
  await unmount()
}

// Friendly names remain distinguishable when two wallets have the same device label.
{
 const picks: string[] = []
 const {container,unmount}=await render(React.createElement(EmulatorWalletChooser, {
  wallets:[{name:'qa-one',label:'KeepKey',hasMnemonic:true},{name:'qa-two',label:'KeepKey',hasMnemonic:true}],
  firmware:{builds,next:{id:PIN,version:'7.17.0',problem:null}},onPick:(name:string)=>picks.push(name),onClose:()=>{},
 }))
 out.distinctNames=[...container.querySelectorAll('button[title^="Start "]')].map(button=>button.getAttribute('aria-label'))
 await click(byLabel(container,'Start KeepKey (qa-two) on v7.17.0 · build 249bcff13435'))
 out.distinctPicks=picks;await unmount()
}

// ── B3: an unavailable selected build is shown, named, and blocks starts ──
{
  const picks: string[] = []
  const problem = 'The selected emulator firmware "v7.17.0 · Monero signing (research)" needs Monero. Turn Monero on in Settings, or pick another firmware.'
  const { container, unmount } = await render(React.createElement(EmulatorWalletChooser, {
    wallets, firmware: { builds: [builds[0]], next: { id: SIGNING, version: '7.17.0', label: 'Monero signing (research)', research: true, problem } },
    onPick: (name: string) => picks.push(name), onClose: () => {},
  }))
  const select = container.querySelector('select[aria-label="Emulator firmware"]') as HTMLSelectElement
  out.unavailableShown = select.selectedOptions[0]?.textContent
  out.unavailableProblem = text(container.querySelector('[data-testid="firmware-recovery"]') ?? container.querySelector('[data-testid="firmware-problem"]')!)
  await click([...container.querySelectorAll('button[title^="Start XMR mainnet"]')][0] ?? null)
  out.unavailablePicks = [...picks]
  await choose(select, PIN)
  out.problemAfterSwitch = container.querySelector('[data-testid="firmware-problem"]') ? 'shown' : 'gone'
  await click(byLabel(container, 'Start XMR mainnet on v7.17.0 · build 249bcff13435'))
  out.picksAfterSwitch = picks
  await unmount()
}

// ── B5: delete asks, names the wallet, says it can't be undone; never the running one ──
{
  const deleted: string[] = []
  const { container, unmount } = await render(React.createElement(EmulatorWalletChooser, {
    wallets, onPick: () => {}, onDelete: (name: string) => deleted.push(name), onClose: () => {},
  }))
  out.deleteButtonsBeforeManage = [...container.querySelectorAll('button[aria-label^="Delete seed"]')].length
  await click(byLabel(container, 'Manage wallets'))
  out.deleteButtons = [...container.querySelectorAll('button[aria-label^="Delete seed "]')].map(b => b.getAttribute('aria-label'))
  await click(byLabel(container, 'Delete seed XMR mainnet'))
  out.deletedAfterX = [...deleted]
  out.confirmText = text(container.querySelector('[data-testid="delete-confirm"]')!)
  const keep = [...container.querySelectorAll('[role="alertdialog"] button')].find(b => text(b) === 'Keep')!
  await click(keep)
  out.confirmAfterKeep = container.querySelector('[data-testid="delete-confirm"]') ? 'open' : 'closed'
  out.deletedAfterKeep = [...deleted]
  await click(byLabel(container, 'Delete seed XMR mainnet'))
  const del = [...container.querySelectorAll('[role="alertdialog"] button')].find(b => text(b) === 'Delete')!
  await click(del)
  out.deleted = deleted
  await unmount()
}

// ── B1/B4: the running badge names wallet and firmware; clicking it asks for the window ──
{
  let shows = 0
  const { container, unmount } = await render(React.createElement(EmulatorBadgeView, {
    wallet: { name: 'build-92079869551ab26c', label: 'XMR mainnet' },
    build: { id: SIGNING, version: '7.17.0', label: 'Monero signing (research)', research: true },
    onShow: () => { shows++ },
  }))
  const badge = container.querySelector('button')!
  out.badgeText = text(badge)
  out.badgeTitle = badge.getAttribute('title')
  await click(badge)
  out.badgeShows = shows
  await unmount()
  const unnamed = await render(React.createElement(EmulatorBadgeView, { wallet: { name: 'build-249bcff134356ee7' }, build: { id: null, version: '7.17.0' } }))
  out.badgeUnnamed = text(unnamed.container.querySelector('button')!)
  await unnamed.unmount()
}

// ── Settings' build select with a research selection hidden while Monero is off ──
{
  const changes: string[] = []
  function SettingsSelect() {
    const [value, setValue] = React.useState(SIGNING)
    return React.createElement('select', { 'aria-label': 'Emulator build', value,
      onChange: (e: any) => { changes.push(e.target.value); setValue(e.target.value) } },
      React.createElement(EmulatorBuildOptions, { builds: [builds[0]], showId: true,
        next: { id: SIGNING, version: '7.17.0', label: 'Monero signing (research)', research: true, problem: 'needs Monero' } }))
  }
  const { container, unmount } = await render(React.createElement(SettingsSelect))
  const select = container.querySelector('select') as HTMLSelectElement
  out.settingsOptions = [...select.options].map(o => o.textContent)
  out.settingsShown = select.selectedOptions[0]?.textContent
  await choose(select, '')
  out.settingsChanges = changes
  out.settingsShownAfter = select.selectedOptions[0]?.textContent
  await unmount()
}

console.log(JSON.stringify(out))
