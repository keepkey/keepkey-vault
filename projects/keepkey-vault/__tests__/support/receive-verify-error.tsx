/** Actual ReceiveView: a failed "Verify on device" is shown, never silent (audit v6 U3). */
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'getComputedStyle', 'localStorage']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(window as any).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
const { act } = React
const pending: Array<{ resolve: (v: any) => void; reject: (e: any) => void }> = []
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  onRpcMessage: () => () => {},
}))
console.error = () => {}
const { createRoot } = await import('react-dom/client')
const { ChakraProvider, defaultSystem } = await import('@chakra-ui/react')
const i18n = (await import('../../src/mainview/i18n')).default
const { CHAINS } = await import('../../src/shared/chains')
const { ReceiveView } = await import('../../src/mainview/components/ReceiveView')
const { showWatchOnlyAddress, watchOnlyAddressMismatchMessage } = await import('../../src/shared/watch-only-verify')
const eth = CHAINS.find(c => c.id === 'ethereum')!
const a1 = '0x0000000000000000000000000000000000000001'
const a2 = '0x0000000000000000000000000000000000000002'
const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 5)) }) }
const render = async (address: string, extra: any = {}) => {
  await act(async () => root.render(<ChakraProvider value={defaultSystem}><ReceiveView chain={eth} address={address} loading={false} error={null} currentPath={[0x8000002c, 0x8000003c, 0x80000000, 0, 0]} onDerive={() => {}} {...extra} /></ChakraProvider>))
  await settle()
}
const verifyButton = () => [...container.querySelectorAll('button')].find(b => /Verify on Device|Check device/.test(b.textContent || ''))!
const click = async () => { await act(async () => { verifyButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }); await settle() }
const fail = async (message: string) => { await act(async () => { pending.shift()!.reject(new Error(message)) }); await settle() }
const succeed = async () => { await act(async () => { pending.shift()!.resolve(a1) }); await settle() }
const alert = () => container.querySelector('[data-verify-error]')?.textContent ?? null
const state = () => ({ alert: alert(), busy: verifyButton().disabled })
const result: any = {}
try {
  await i18n.changeLanguage('en')
  await render(a1)
  await click()
  result.verifying = state()
  await fail('Action cancelled by user')
  result.cancelled = state()
  await click()
  result.retrying = state()
  await fail('RPC request timed out: ethGetAddress')
  result.noAnswer = state()
  await click()
  await succeed()
  result.succeeded = state()
  await click()
  await fail('LIBUSB_ERROR_PIPE')
  result.deviceLost = state()
  await render(a2)
  result.addressChanged = state()
  await render(a1)
  result.backToFailedAddress = state()
  await click()
  await fail('LIBUSB_ERROR_PIPE')
  await render(a1, { loading: true })
  await render(a1)
  result.rederived = state()
  await render(a2)
  await click()
  await render(a1)
  await fail('Failure_Other')
  result.staleReply = state()
  await click()
  await fail('Failure_Other')
  result.other = state()
  await render(a1, { onShowOnDevice: async () => { throw new Error('Failure_Other') } })
  await click()
  result.customHandler = state()
  await render(a1, { onShowOnDevice: () => { throw new Error('Failure_Other') } })
  await click()
  result.syncThrow = state()
  // Watch-only (AssetPage's handler): a cancel reads like any account's check; a
  // different address on the device hides the host one instead (KEEPKEY-138).
  const mismatches: string[] = []
  const watchOnly = (error: Error) => ({ watchOnly: true, onShowOnDevice: () => showWatchOnlyAddress(async () => { throw error }, m => { mismatches.push(m) }) })
  await render(a1, watchOnly(new Error('Action cancelled by user')))
  await click()
  result.watchOnlyCancelled = { ...state(), mismatches: mismatches.length }
  await render(a1, watchOnly(new Error('Timed out waiting for the KeepKey request. Try again.')))
  await click()
  result.watchOnlyNoAnswer = { ...state(), mismatches: mismatches.length }
  await render(a1, watchOnly(new Error(watchOnlyAddressMismatchMessage(a2, a1))))
  await click()
  result.watchOnlyMismatch = { ...state(), mismatches }
} finally { await act(async () => root.unmount()); container.remove(); dom.window.close() }
console.log(JSON.stringify(result))
