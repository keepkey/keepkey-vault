import { JSDOM } from 'jsdom'
import { expect, mock } from 'bun:test'
import * as React from 'react'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'CustomEvent', 'MouseEvent'])
  (globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
mock.module('../../src/mainview/i18n/ui', () => ({ useUiTranslation: () => (text: string) => text }))
mock.module('../../src/mainview/components/VaultIdentityBadge', () => ({ VaultIdentityBadge: () => null,
  VaultIdentityDetails: ({ vault }: any) => <div>{vault.cosigners.map((c: any) => <p key={c.address}>{c.address}</p>)}</div> }))
mock.module('../../src/mainview/components/AddressBookPicker', () => ({ AddressBookPicker: () => null }))
const owner = '0x909Ef6B32DfDc12CA86aA710b54c991af3C5F82E'
const outsider = '0x27de622cc44c55b53caf299ecedccdab29ac98a8'
const safe = '0x6717d97655d8fC9d05C2DD3F28b54f574309B473'
const extra = '0x4A7d4F1bD5653DbF9FF1EDcC7dF37E4112f27A35'
let currentOwner = outsider, found = false
let discoveryCalls = 0, forced = false
const listeners = new Map<string, Set<(payload?: any) => void>>()
const calls: string[] = []
const account = () => ({ address: safe, name: 'Shared vault', safeVersion: '1.5.0',
  owners: [owner, ...[1, 2, 3].map(n => '0x' + String(n).repeat(40)), ...(found ? [extra] : [])],
  threshold: 2, nonce: '3', deployed: true, reviewedAt: 1234, configurationChanged: found })
mock.module('../../src/mainview/lib/rpc', () => ({
  onRpcMessage: (name: string, callback: (payload?: any) => void) => {
    const callbacks = listeners.get(name) || new Set(); callbacks.add(callback); listeners.set(name, callbacks)
    return () => callbacks.delete(callback)
  },
  rpcRequest: async (method: string, params: any) => {
    calls.push(method)
    if (method === 'safeList') return { owner: currentOwner, session: currentOwner, sessionOnly: false,
      nestedClearSign: true, rpcReady: true, accounts: currentOwner === owner ? [account()] : [], proposals: [] }
    if (method === 'getAppSettings') return { evmSimulationRpcUrls: {} }
    if (method === 'safeDiscover') {
      discoveryCalls++; forced ||= !!params.force; found = currentOwner === owner
      return { owner: currentOwner, session: currentOwner, discovered: found ? 1 : 0, issues: [] }
    }
    if (method === 'safeSync') return { address: safe, checkedAt: Date.now(), pending: 0, imported: 0, issues: [] }
    throw new Error(`Unexpected RPC ${method}`)
  },
}))
globalThis.fetch = (() => { throw new Error('Network forbidden in discovery UI fixture') }) as typeof fetch
const { act } = React
const { createRoot } = await import('react-dom/client')
const { SafeMultisigView } = await import('../../src/mainview/components/SafeMultisigView')
const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const emit = (name: string, payload?: any) => listeners.get(name)?.forEach(callback => callback(payload))
await act(async () => root.render(<SafeMultisigView />))
expect(container.textContent).not.toContain('Shared vault')
expect(discoveryCalls).toBe(1)
await act(async () => {
  currentOwner = owner
  emit('wallet-data-purged')
  emit('device-state', { state: 'ready', deviceId: 'same-physical-keepkey' })
  await new Promise(resolve => setTimeout(resolve, 200))
})
expect(container.textContent).toContain('Shared vault')
expect(container.textContent).toContain(safe)
expect(container.textContent).toContain('Review changed owners')
const click = async (label: string) => {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label)
  expect(button).toBeDefined(); expect(button!.disabled).toBe(false)
  await act(async () => button!.click())
}
await click('Find my Safes')
expect(forced).toBe(true)
await click('Review changed owners')
expect(container.textContent).toContain(extra)
expect(calls).not.toContain('safeImport')
expect(calls).not.toContain('ethSignTypedData')
expect(calls).not.toContain('safeBroadcast')
await act(async () => {
  currentOwner = outsider
  emit('wallet-data-purged')
  emit('device-state', { state: 'ready', deviceId: 'same-physical-keepkey' })
  await new Promise(resolve => setTimeout(resolve, 200))
})
expect(container.textContent).not.toContain('Shared vault')
await act(async () => root.unmount())
console.log(JSON.stringify({ autoLoaded: true, changedOwnersRequireReview: true, manualRefresh: forced,
  walletSwitchHidesSafe: true, noSigning: true }))
