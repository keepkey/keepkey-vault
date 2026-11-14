/** The actual App with a locked KeepKey: auto PIN prompt, Cancel, "Open view-only".
 *  Synthetic RPC replies and device-state pushes only; no device, network or user data. */
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'localStorage', 'sessionStorage']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(window as any).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
globalThis.fetch = (() => { throw new Error('Network forbidden in App fixture') }) as typeof fetch
const React = await import('react')
const { act } = React
const listeners = new Map<string, Set<(value: any) => void>>()
const calls: string[] = []
let rejectUnlock: ((error: Error) => void) | undefined
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: (method: string) => {
    calls.push(method)
    // The PIN prompt stays open until the user cancels it on the pad.
    if (method === 'requestDeviceUnlock') return new Promise((_resolve, reject) => { rejectUnlock = reject })
    if (method === 'getDeviceState') return Promise.resolve(device('disconnected'))
    if (method === 'getAppSettings') return Promise.resolve({ disabledNetworks: [], passphraseIntroShown: true })
    if (method === 'checkWatchOnlyCache') return Promise.resolve({ available: true, deviceLabel: 'Fixture KeepKey', lastSynced: 1 })
    if (method === 'watchOnlySetView') return Promise.resolve({ bitcoinOnly: false })
    return Promise.resolve(null)
  },
  rpcFire: () => {},
  dispatchLocalRpcMessage: (name: string, value: any) => { for (const callback of listeners.get(name) || []) callback(value) },
  onRpcMessage: (name: string, callback: (value: any) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name)!.add(callback)
    return () => listeners.get(name)!.delete(callback)
  },
}))
mock.module('../../src/mainview/components/Dashboard', () => ({ Dashboard: ({ watchOnly }: any) => <div data-dashboard={watchOnly ? 'view-only' : 'live'} /> }))
mock.module('../../src/mainview/components/DeviceGrid', () => ({ DeviceGrid: ({ onViewPortfolio, onReady }: any) => {
  React.useEffect(() => { onReady?.() }, [])
  return <button data-open-view-only onClick={() => onViewPortfolio('fixture-device', 'Fixture KeepKey')}>Open view-only</button>
} }))
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
await import('../../src/mainview/i18n')
const { default: App } = await import('../../src/mainview/App')
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }) }
const push = async (name: string, value: any) => { await act(async () => { for (const callback of listeners.get(name) || []) callback(value) }); await settle() }
function device(state: string) {
  return { state, deviceId: 'fixture-device', activeTransport: 'webusb', updatePhase: 'idle', bootloaderMode: false,
    needsBootloaderUpdate: false, needsFirmwareUpdate: false, needsInit: false, initialized: true, passphraseProtection: false, isOob: false, isEmulator: false }
}
const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const unlocks = () => calls.filter(c => c === 'requestDeviceUnlock').length
const view = () => container.querySelector('[data-dashboard]')?.getAttribute('data-dashboard') ?? null
const result: Record<string, unknown> = {}
try {
  await act(async () => root.render(<ChakraProvider value={defaultSystem}><App /></ChakraProvider>))
  await settle()
  await push('device-state', device('needs_pin'))
  result.pluggedInLocked = { unlockRequests: unlocks(), view: view() }
  // Cancel on the PIN pad: the unlock request ends without unlocking.
  await act(async () => { rejectUnlock?.(new Error('PIN cancelled')) }); await settle()
  await act(async () => { container.querySelector('[data-open-view-only]')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle(); await settle()
  result.viewOnlyAfterCancel = { unlockRequests: unlocks(), view: view() }
  // A state re-push for the same locked device keeps view-only and asks for nothing.
  await push('device-state', device('needs_pin'))
  result.stillLocked = { unlockRequests: unlocks(), view: view() }
  // Replugged, still locked: no PIN prompt opens over the cached wallet.
  await push('device-state', { ...device('disconnected'), deviceId: undefined, activeTransport: null })
  await push('device-state', device('needs_pin'))
  result.replugLocked = { unlockRequests: unlocks(), view: view() }
  await push('device-state', device('ready'))
  result.unlockedOnDevice = { view: view() }
} finally { await act(async () => root.unmount()); container.remove(); dom.window.close() }
console.log(JSON.stringify(result))
