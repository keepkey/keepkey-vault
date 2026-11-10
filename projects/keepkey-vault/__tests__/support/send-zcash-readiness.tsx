// Actual SendForm and readiness hook, with no device, wallet, IPC or network.
import { JSDOM } from 'jsdom'
import { expect, mock } from 'bun:test'
import * as React from 'react'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent']) (globalThis as any)[key] = (dom.window as any)[key]
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const translate = (key: string) => key
const element = (tag: string) => (props: any) => React.createElement(tag,
  Object.fromEntries(Object.entries(props).filter(([key]) => /^(on[A-Z]|aria-|data-)/.test(key) || ['value', 'disabled', 'placeholder', 'title', 'role', 'type'].includes(key))), props.children)
mock.module('@chakra-ui/react', () => ({ Box: element('div'), Flex: element('div'), Text: element('span'), VStack: element('div'), Button: element('button'), Input: element('input'), Spinner: element('span') }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }))
mock.module('../../src/mainview/i18n/ui', () => ({ useUiTranslation: () => translate }))
mock.module('../../src/mainview/lib/fiat-context', () => ({ useFiat: () => ({ locale: 'en-US', fmt: String, fmtCompact: String }) }))
mock.module('../../src/mainview/lib/formatting', () => ({ formatBalance: String }))
mock.module('../../src/mainview/lib/signing-errors', () => ({ describeSigningError: (error: Error) => error.message }))
mock.module('../../src/mainview/lib/sounds', () => ({ playSent() {} }))
mock.module('../../src/shared/assetLookup', () => ({ getAsset: () => null }))
mock.module('../../src/shared/address-validation', () => ({ validateAddress: () => ({ valid: true }) }))
for (const name of ['QrScannerOverlay', 'AddressBookPicker', 'AddressIdenticon', 'SaveRecipientDialog', 'DocsLink']) mock.module(`../../src/mainview/components/${name}`, () => ({ [name]: () => null }))
function deferred() {
  let resolve!: (value: any) => void, reject!: (error: Error) => void
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const statusCalls: ReturnType<typeof deferred>[] = []
const settingsCalls: Array<{ enabled: boolean; pending: ReturnType<typeof deferred> }> = []
const calls: Array<{ method: string; pending: ReturnType<typeof deferred> }> = []
let broadcasts = 0
const listeners = new Map<string, Set<(payload: any) => void>>()
const request = async (method: string, params: any) => {
  if (method === 'setAlphaFirmware') { const pending = deferred(); settingsCalls.push({ enabled: params.enabled, pending }); return pending.promise }
  if (method === 'getZcashNu7Support') { const pending = deferred(); statusCalls.push(pending); return pending.promise }
  if (method === 'checkVaultDestination') return undefined
  if (method === 'matchAddress') return { address: params.address, kind: 'external', label: 'Known test recipient' }
  if (method === 'broadcastTx') { broadcasts++; throw new Error('Broadcast is forbidden') }
  if (!['buildTx', 'btcSignTx', 'ethSignTx'].includes(method)) throw new Error(`Forbidden RPC ${method}`)
  const pending = deferred(); calls.push({ method, pending }); return pending.promise
}
mock.module('../../src/mainview/lib/rpc', () => ({
  onRpcMessage: (name: string, receive: (payload: any) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name)!.add(receive)
    return () => listeners.get(name)!.delete(receive)
  },
  rpcRequest: request,
}))
globalThis.fetch = (() => { throw new Error('Network forbidden') }) as typeof fetch
const { act } = React
const { createRoot } = await import('react-dom/client')
const { CHAINS } = await import('../../src/shared/chains')
const { SendForm } = await import(process.env.SEND_FORM_UNDER_TEST || '../../src/mainview/components/SendForm')
const zcash = CHAINS.find(c => c.id === 'zcash')!, ethereum = CHAINS.find(c => c.id === 'ethereum')!
const notice = 'Zcash sending requires the 7.17 alpha emulator. Hardware support is not available yet.'
const checking = 'Checking Zcash sending support…'
const status = (available: boolean, sessionId = 'synthetic-session-A') => ({ available, requiredFirmware: '7.17.0', emulatorOnly: true, alphaOnly: true, sessionId })
const device = (patch = {}) => ({ deviceId: 'synthetic-device', activeTransport: 'emulator', isEmulator: true, firmwareVersion: '7.17.0', state: 'ready', ...patch })
let root: ReturnType<typeof createRoot>, container: HTMLDivElement, props: any
const settle = async (ms = 0) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
const render = async (patch = {}) => { props = { ...props, ...patch }; await act(async () => root.render(<SendForm {...props} />)); await settle() }
const mount = async (patch = {}) => {
  calls.length = 0; statusCalls.length = 0
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  props = { chain: zcash, address: 'synthetic-own-address', balance: { chainId: zcash.id, balance: '10', balanceUsd: 10, syncState: 'confirmed' }, ...patch }
  await render()
}
const unmount = async () => { await act(async () => root.unmount()); container.remove() }
const text = () => container.textContent || ''
const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label)!
const input = (placeholder: string) => container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!
const setInput = async (placeholder: string, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input(placeholder), value)
    input(placeholder).dispatchEvent(new window.Event('input', { bubbles: true }))
  }); await settle()
}
const fill = async () => { await setInput('addressPlaceholder', 'synthetic-recipient'); await setInput('amountPlaceholder', '1'); await settle(330) }
const click = async (label: string) => { expect(button(label).disabled).toBe(false); await act(async () => button(label).click()); await settle() }
const resolveStatus = async (value: any, call = statusCalls.at(-1)!) => { await act(async () => call.resolve(value)); await settle() }
const emit = (name: string, payload: any) => { for (const receive of [...listeners.get(name) || []]) receive(payload) }
const event = async (name: string, payload: any) => { await act(async () => emit(name, payload)); await settle() }
const build = async () => {
  await click('buildTransaction')
  await act(async () => calls.at(-1)!.pending.resolve({ unsignedTx: { coin: 'Zcash', fixture: true }, fee: '0.00015', feeUsd: 0 }))
  await settle()
  expect(button('signOnDevice').disabled).toBe(false)
}
const result: Record<string, unknown> = {}

// Execute the production settings callback rather than reproducing its event
// dispatch in this fixture or mounting the unrelated settings/device controls.
const settingsFile = new URL('../../src/mainview/components/DeviceSettingsDrawer.tsx', import.meta.url)
const settingsSource = ts.createSourceFile(settingsFile.pathname,
  readFileSync(process.env.SETTINGS_DRAWER_UNDER_TEST || settingsFile, 'utf8'), ts.ScriptTarget.Latest, true)
let toggleExpression: ts.Expression | undefined
const visit = (node: ts.Node) => {
  if (ts.isVariableDeclaration(node) && node.name.getText(settingsSource) === 'toggleAlphaFirmware'
    && node.initializer && ts.isCallExpression(node.initializer)) toggleExpression = node.initializer.arguments[0]
  ts.forEachChild(node, visit)
}
visit(settingsSource)
if (!toggleExpression) throw new Error('Production alpha toggle callback missing')
const toggleJs = ts.transpileModule(`const toggle = ${toggleExpression.getText(settingsSource)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText
const savedSettings: unknown[] = [], toggling: boolean[] = []
const toggleAlphaFirmware = new Function('rpcRequest', 'setAppSettings', 'setTogglingAlphaFirmware', 'console', 'window', 'Event', `${toggleJs}; return toggle`)(
  request, (value: unknown) => savedSettings.push(value), (value: boolean) => toggling.push(value),
  { error() {} }, window, window.Event,
)

await mount(); await fill()
expect(button('buildTransaction').disabled).toBe(true)
expect(text()).toContain(notice); expect(container.querySelector(`[aria-label="${checking}"]`)).not.toBeNull()
expect(calls).toHaveLength(0)
await resolveStatus(status(false)) // physical 7.16
expect(button('buildTransaction').disabled).toBe(true); expect(container.querySelector(`[aria-label="${checking}"]`)).toBeNull()
await event('device-state', device({ firmwareVersion: '7.17.0', isEmulator: false, activeTransport: 'hid' }))
await resolveStatus(status(false)) // physical 7.17 is also deliberately unsupported
expect(button('buildTransaction').disabled).toBe(true); result.physicalVersions = 2
await event('emulator-status', { state: 'running' }); await resolveStatus(status(true))
expect(button('buildTransaction').disabled).toBe(false); await build(); result.qualifiedEmulator = true

// Pending refresh immediately revokes even a click through an old rendered handler.
const oldSign = button('signOnDevice')
await act(async () => {
  window.dispatchEvent(new window.Event('keepkey-settings-changed'))
  oldSign.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
await settle(); expect(calls.filter(c => c.method === 'btcSignTx')).toHaveLength(0)
expect(button('signOnDevice').disabled).toBe(true); result.immediateRevocation = true
await resolveStatus(status(false)) // alpha flag off
expect(button('signOnDevice')).toBeUndefined(); expect(button('buildTransaction').disabled).toBe(true)
expect(input('amountPlaceholder').value).toBe('1'); result.alphaDisabled = true

await event('device-state', device()); const stale = statusCalls.at(-1)!
await act(async () => window.dispatchEvent(new window.Event('keepkey-settings-changed'))); await settle()
await resolveStatus(status(false)); await resolveStatus(status(true), stale)
expect(button('buildTransaction').disabled).toBe(true); result.staleStatus = true
await event('emulator-status', { state: 'running' }); await resolveStatus(status(true)); await build()

// PIN/unlock pushes do not discard a valid review or a legitimate in-flight signature.
await event('device-state', device({ state: 'locked', pinPromptOpen: true })); await resolveStatus(status(true))
expect(button('signOnDevice').disabled).toBe(false)
await click('signOnDevice'); const signing = calls.at(-1)!
await event('device-state', device({ state: 'ready', pinPromptOpen: false })); await resolveStatus(status(true))
await act(async () => signing.pending.resolve('synthetic signed transaction')); await settle()
expect(text()).toContain('transactionSigned'); result.unlockPreservesReview = true
const oldBroadcast = button('broadcastTransaction')
await act(async () => {
  window.dispatchEvent(new window.Event('keepkey-settings-changed'))
  oldBroadcast.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
await settle(); expect(broadcasts).toBe(0)
expect(button('broadcastTransaction').disabled).toBe(true)
await resolveStatus(status(true)); expect(button('broadcastTransaction').disabled).toBe(false)
await unmount()

await mount(); await fill(); await resolveStatus(status(true)); await build(); await click('signOnDevice')
const retired = calls.at(-1)!
await event('wallet-data-purged', {}); await resolveStatus(status(false))
await act(async () => retired.pending.resolve('retired signature')); await settle()
expect(text()).not.toContain('transactionSigned'); expect(button('broadcastTransaction')).toBeUndefined(); result.retiredSigning = true
await unmount()

// The very first device push may already describe another qualified emulator.
// Its authoritative host session id must retire A even without an initial push.
await mount(); await fill(); await resolveStatus(status(true, 'session-A')); await build(); await click('signOnDevice')
const firstDeviceSign = calls.at(-1)!
await event('device-state', device({ deviceId: 'different-qualified-device' }))
await resolveStatus(status(true, 'session-B'))
await act(async () => firstDeviceSign.pending.resolve('old session signature')); await settle()
expect(text()).not.toContain('transactionSigned'); expect(button('broadcastTransaction')).toBeUndefined()
expect(button('buildTransaction').disabled).toBe(false); result.firstDevicePush = true
await unmount()

await mount(); await fill(); const oldOwner = statusCalls.at(-1)!
await render({ address: 'other-synthetic-owner' }); await resolveStatus(status(false)); await resolveStatus(status(true), oldOwner)
expect(button('buildTransaction').disabled).toBe(true); result.ownerScope = true
const before = statusCalls.length
await render({ chain: ethereum, address: '0x' + '11'.repeat(20) }); await fill()
expect(text()).not.toContain(notice); expect(button('buildTransaction').disabled).toBe(false)
expect(statusCalls.length).toBe(before); result.otherChain = true
await unmount()

await mount(); const abandoned = statusCalls.at(-1)!
await unmount(); await resolveStatus(status(true), abandoned)
expect([...listeners.values()].every(set => set.size === 0)).toBe(true); result.unmounted = true

await mount(); await fill(); await act(async () => statusCalls.at(-1)!.reject(new Error('offline status bridge'))); await settle()
expect(button('buildTransaction').disabled).toBe(true); expect(text()).toContain(notice); result.statusFailure = true
await event('emulator-status', { state: 'running' }); await resolveStatus({ available: true })
expect(button('buildTransaction').disabled).toBe(true); result.malformedStatus = true
await unmount()
// Only a successful saved toggle announces a new readiness check. Both ON and
// OFF propagate while the current SendForm remains mounted.
await mount(); await fill(); await resolveStatus(status(false))
let settingsEvents = 0
const countSettings = () => settingsEvents++
window.addEventListener('keepkey-settings-changed', countSettings)
let priorReads = statusCalls.length
const enabling = toggleAlphaFirmware(true)
expect(settingsCalls.at(-1)!.enabled).toBe(true)
expect(statusCalls.length).toBe(priorReads); expect(settingsEvents).toBe(0); result.settingsPending = true
await act(async () => { settingsCalls.at(-1)!.pending.resolve({ alphaFirmware: true }); await enabling })
await settle()
expect(savedSettings).toEqual([{ alphaFirmware: true }]); expect(settingsEvents).toBe(1)
expect(statusCalls.length).toBe(priorReads + 1); expect(button('buildTransaction').disabled).toBe(true)
await resolveStatus(status(true)); expect(button('buildTransaction').disabled).toBe(false)
priorReads = statusCalls.length
const failing = toggleAlphaFirmware(false)
expect(statusCalls.length).toBe(priorReads); expect(settingsEvents).toBe(1)
await act(async () => { settingsCalls.at(-1)!.pending.reject(new Error('Save failed')); await failing })
await settle()
expect(savedSettings).toHaveLength(1); expect(statusCalls.length).toBe(priorReads); expect(settingsEvents).toBe(1)
expect(button('buildTransaction').disabled).toBe(false); result.settingsFailure = true
await build()
const disabling = toggleAlphaFirmware(false)
expect(settingsEvents).toBe(1); expect(statusCalls.length).toBe(priorReads)
await act(async () => { settingsCalls.at(-1)!.pending.resolve({ alphaFirmware: false }); await disabling })
await settle()
expect(savedSettings).toEqual([{ alphaFirmware: true }, { alphaFirmware: false }]); expect(settingsEvents).toBe(2)
expect(statusCalls.length).toBe(priorReads + 1); expect(button('signOnDevice').disabled).toBe(true)
expect(calls.filter(call => call.method === 'btcSignTx')).toHaveLength(0)
await resolveStatus(status(false)); expect(button('buildTransaction').disabled).toBe(true)
expect(toggling).toEqual([true, false, true, false, true, false]); result.settingsSaved = true
window.removeEventListener('keepkey-settings-changed', countSettings)
await unmount()
result.broadcasts = broadcasts
console.log(JSON.stringify(result))
dom.window.close()
