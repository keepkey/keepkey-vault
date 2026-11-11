import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Review of #618: three vault paths reached users with Multisig OFF.
const read = (p: string) => readFileSync(join(import.meta.dir, '..', p), 'utf8')
const index = read('src/bun/index.ts')
const send = read('src/mainview/components/SendForm.tsx')

describe('Multisig off never breaks ordinary sends or contacts', () => {
  test('a contact-lookup failure cannot become a vault-destination error that disables Send', () => {
    const chain = send.slice(send.indexOf('"matchAddress"'), send.indexOf('setVaultDestinationError(e.message'))
    expect(chain).toContain('.catch(() => { /* contact detection is best-effort; never block sending */ }))')
  })
  test('sends still work without the database (no saved vaults to protect)', () => {
    const fn = index.slice(index.indexOf('function registeredVaults()'), index.indexOf('function vaultAddressEntries('))
    expect(fn).toContain('(getDb() ? vaultBook().list().map(e => e.vault!) : [])')
  })
  test('the Address Book loads vault rows only with Multisig on, and a vault failure keeps the contacts', () => {
    const handler = index.slice(index.indexOf('listAddressBook: async'), index.indexOf('addAddressBook: async'))
    expect(handler).toContain('multisigFeature.enabled && getDb()')
    expect(handler).toContain("console.warn('[addressbook] vaults unavailable:'")
    expect(handler).not.toMatch(/^\s*await listRegisteredVaults\(\)\s*$/m)
  })
})

// 1.6.10 on hardware: toggling Multisig on did not show the Ethereum Multisig pill.
describe('the Multisig toggle takes effect without a remount', () => {
  const asset = read('src/mainview/components/AssetPage.tsx')
  const app = read('src/mainview/App.tsx')
  test('Safe chains are refetched when the flag turns on (the gate answers [] while off)', () => {
    const effect = asset.slice(asset.indexOf("rpcRequest<number[]>('safeChains'") - 200, asset.indexOf("rpcRequest<number[]>('safeChains'") + 200)
    expect(effect).toContain("!multisigEnabled) return")
    expect(effect).toContain('[chain.chainFamily, multisigEnabled]')
  })
  test('AssetPage reads the flag from one place', () => {
    expect(asset).not.toContain('setBtcMultisigEnabled')
  })
  test('turning it off leaves the open Multisig panel, tab and vault view', () => {
    expect(asset).toContain('if (view === "multisig" && !multisigEnabled) setView("receive")')
    expect(app).toContain('if (activeTab === "multisig") setActiveTab("vault")')
    expect(app).toMatch(/if \(multisigEnabled\) return[\s\S]{0,120}setViewingVault\(null\)/)
  })
})
