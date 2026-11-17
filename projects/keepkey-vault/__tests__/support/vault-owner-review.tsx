import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
import * as React from 'react'
import { safeVaultIdentity, BASE_ETH_CAIP, BASE_NETWORK } from '../../src/shared/vault-identity'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'CustomEvent', 'MouseEvent']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
dom.window.HTMLElement.prototype.scrollTo = () => {}
mock.module('../../src/mainview/i18n/ui', () => ({ useUiTranslation: () => (text: string) => text }))
mock.module('../../src/mainview/lib/fiat-context', () => ({ useFiat: () => ({ privateModeEnabled: false }) }))
mock.module('../../src/mainview/lib/qr', () => ({ generateQRSvg: () => '<svg/>' }))
mock.module('../../src/mainview/components/AssetIcon', () => ({ AssetIcon: () => null }))
mock.module('../../src/mainview/components/SafeMultisigView', () => ({ SafeMultisigView: () => null }))

const account = {
  address: '0x6717d97655d8fC9d05C2DD3F28b54f574309B473', name: 'Shared vault',
  safeVersion: '1.5.0' as const, owners: [1, 2, 3, 4].map(n => '0x' + String(n).repeat(40)),
  threshold: 2, nonce: '0', deployed: true, reviewedAt: 1, balanceEth: '0.125', balanceUsdc: '42.5',
}
const fresh = { ...account, owners: [...account.owners, '0x' + '5'.repeat(40)], reviewedAt: 2 }
const calls: string[] = []
let writes = 0
mock.module('../../src/mainview/lib/rpc', () => ({
  onRpcMessage: () => () => {},
  rpcRequest: async (method: string, params: any) => {
    calls.push(method)
    if (method === 'vaultAccountGet') return { identity: safeVaultIdentity(fresh, false), safe: fresh, assetCaip: BASE_ETH_CAIP }
    if (method === 'vaultAddPreview') {
      if (params.address !== account.address) throw new Error('Review selected a different contract')
      return { id: 'review', account: fresh, sessionOnly: false, rpcHost: 'mainnet.base.org' }
    }
    if (method === 'vaultAddConfirm') { writes++; return safeVaultIdentity(fresh, false) }
    throw new Error(`Unexpected RPC: ${method}`)
  },
}))
globalThis.fetch = (() => { throw new Error('Network forbidden in owner-review fixture') }) as typeof fetch

const { act } = React
const { createRoot } = await import('react-dom/client')
const { VaultAssetAccount } = await import('../../src/mainview/components/VaultAssetAccount')
const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
await act(async () => root.render(<VaultAssetAccount vault={safeVaultIdentity(account, false)}
  assetCaip={BASE_ETH_CAIP} networkId={BASE_NETWORK} action="receive" selector={null}
  onAction={() => {}} onAsset={() => {}} onBack={() => {}} onBusy={() => {}} />))
const text = () => document.body.textContent || ''
const initialBlocked = text().includes('Vault configuration changed')
const click = async (label: string) => {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label)!
  await act(async () => button.click())
}
await click('Verify & review vault →')
const input = document.querySelector('.vault-add-dialog input') as HTMLInputElement
const prefilledAddress = input.value
await act(async () => document.querySelector('.vault-add-dialog form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
const fifthSignerShown = text().includes(fresh.owners[4])
const writesBeforeConfirmation = writes
await click('Confirm owners & add vault')
const verifiedAfterReview = !document.querySelector('[role="alert"]') && text().includes('0.125')
await act(async () => root.unmount())
console.log(JSON.stringify({ initialBlocked, prefilledAddress, fifthSignerShown, writesBeforeConfirmation, verifiedAfterReview: !!verifiedAfterReview, writes, calls }))
