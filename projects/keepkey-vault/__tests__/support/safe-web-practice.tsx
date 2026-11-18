import { JSDOM } from 'jsdom'
import { expect, mock } from 'bun:test'
import * as React from 'react'
import { Wallet } from 'ethers'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'CustomEvent', 'MouseEvent'])
  (globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
mock.module('../../src/mainview/i18n/ui', () => ({ useUiTranslation: () => (text: string) => text }))
mock.module('../../src/mainview/components/VaultIdentityBadge', () => ({ VaultIdentityBadge: () => null, VaultIdentityDetails: () => null }))
const owner = new Wallet('0x' + '11'.repeat(32)).address
const coowner = new Wallet('0x' + '22'.repeat(32)).address
const safe = '0x1111111111111111111111111111111111111111'
let pickerChecked = false
mock.module('../../src/mainview/components/AddressBookPicker', () => ({ AddressBookPicker: (props: any) => {
  expect(props.networkId).toBe('eip155:8453')
  expect(props.entryFilter({ address: owner })).toBe(false)
  expect(props.entryFilter({ address: coowner, vault: {} })).toBe(false)
  expect(props.entryFilter({ address: 'example.eth' })).toBe(false)
  expect(props.entryFilter({ address: coowner })).toBe(true)
  pickerChecked = true
  return <button onClick={() => props.onSelect({ address: coowner, label: 'Web wallet' })}>Pick web wallet</button>
} }))
const account = { address: safe, name: 'Practice', owners: [owner, coowner], threshold: 2, nonce: '0', deployed: true, balanceEth: '0.1' }
const proposal = { format: 'keepkey-safe-v1', chainId: 8453, safe, hash: '0x' + 'ab'.repeat(32),
  transaction: { to: coowner, value: '1000000000000', data: '0x', nonce: '0' }, signatures: {} as Record<string, string> }
let shared = false, webApproved = false, prepared = false
let polls = 0, executionReviews = 0
const calls: string[] = []
mock.module('../../src/mainview/lib/rpc', () => ({ rpcRequest: async (method: string, params: any) => {
  calls.push(method)
  if (method === 'safeList') return { owner, session: 'practice', sessionOnly: false, nestedClearSign: true, rpcReady: true,
    accounts: [account], proposals: [structuredClone(proposal)] }
  if (method === 'getAppSettings') return { evmSimulationRpcUrls: {} }
  if (method === 'safeSync') {
    polls++
    if (webApproved) proposal.signatures[coowner] = 'web-signature'
    return { address: safe, checkedAt: Date.now(), pending: webApproved ? 1 : 0, imported: webApproved ? 1 : 0, issues: [] }
  }
  if (method === 'safePrepareCreate') {
    expect(params.otherOwners).toEqual([coowner]); expect(params.threshold).toBe(2)
    prepared = true; throw new Error('Creation review reached')
  }
  if (method === 'safeSigningData') return { addressNList: [1], typedData: {} }
  if (method === 'ethSignTypedData') return { signature: 'keepkey-signature' }
  if (method === 'safeAddSignature') { proposal.signatures[owner] = params.signature; return proposal }
  if (method === 'safePublish') {
    expect(params.hash).toBe(proposal.hash); expect(proposal.signatures[owner]).toBe('keepkey-signature')
    shared = true; return { hash: proposal.hash }
  }
  if (method === 'safePrepareExecute') { executionReviews++; throw new Error('Execution review reached') }
  throw new Error(`Unexpected RPC ${method}`)
} }))
globalThis.fetch = (() => { throw new Error('Network forbidden in practice UI fixture') }) as typeof fetch
const { act } = React
const { createRoot } = await import('react-dom/client')
const { SafeMultisigView } = await import('../../src/mainview/components/SafeMultisigView')
const container = document.createElement('div'); document.body.appendChild(container)
let root = createRoot(container)
const click = async (label: string) => {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label)
  expect(button).toBeDefined(); expect(button!.disabled).toBe(false)
  await act(async () => button!.click())
}
await act(async () => root.render(<SafeMultisigView initialCreate />))
await click('Address book')
await click('Pick web wallet')
expect((container.querySelector('[aria-label="Owner 2 address"]') as HTMLInputElement).value).toBe(coowner)
await act(async () => container.querySelector('form.safe-panel')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
expect(prepared).toBe(true)
await act(async () => root.unmount())
root = createRoot(container)
await act(async () => root.render(<SafeMultisigView initialAddress={safe} />))
expect(polls).toBeGreaterThan(0)
await act(async () => (container.querySelector('button.safe-proposal') as HTMLButtonElement).click())
expect([...container.querySelectorAll('button')].some(b => b.textContent === 'Review execution →')).toBe(false)
await click('Approve with KeepKey')
await click('Share with Safe')
expect(shared).toBe(true)
webApproved = true
await click('↻ Refresh')
await click('Review execution →')
expect(executionReviews).toBe(1)
expect(calls).not.toContain('ethSignTx')
expect(calls).not.toContain('safeBroadcast')
await act(async () => root.unmount())
console.log(JSON.stringify({ pickerChecked, prepared, shared, approvals: Object.keys(proposal.signatures).length, executionReviews, noBroadcast: true }))
