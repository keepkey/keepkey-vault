import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Review of #618: three vault paths reached users with Multisig OFF.
const read = (p: string) => readFileSync(join(import.meta.dir, '..', p), 'utf8')
const index = read('src/bun/index.ts')

describe('Multisig off never breaks ordinary sends or contacts', () => {
  test('a contact-lookup failure cannot become a vault-destination error that disables Send', () => {
    // Isolate the mounted form's module mocks from the rest of the unit suite.
    // The shared fixture forbids network, device, wallet and unexpected RPCs.
    const fixture = new URL('./support/send-form-fixture.tsx', import.meta.url).pathname
    const source = `
      import { expect } from 'bun:test'
      const form = await import(${JSON.stringify(fixture)})
      const chain = form.chainById('ethereum')
      const owner = '0x' + '11'.repeat(20), recipient = '0x' + '33'.repeat(20)
      const props = { chain, address: owner, balance: { chainId: chain.id,
        balance: '10', balanceUsd: 100, nativeBalanceUsd: 100, address: owner, syncState: 'confirmed' } }

      await form.mount(props)
      form.destinationLookupErrors.contact = new Error('Contact database unavailable')
      await form.setRecipient(recipient)
      await form.setInput('amountPlaceholder', '1')
      expect(form.destinationLookupCalls).toEqual(['checkVaultDestination', 'matchAddress'])
      expect(form.text()).not.toContain('Contact database unavailable')
      expect(form.button('buildTransaction').disabled).toBe(false)
      await form.click('buildTransaction')
      expect(form.calls).toHaveLength(1)
      expect(form.lastBuild().params).toMatchObject({ chainId: 'ethereum', to: recipient, amount: '1' })
      await form.unmount()

      // A real vault-verification failure must still block both UI and handler.
      await form.mount(props)
      form.destinationLookupErrors.vault = new Error('Vault destination is forbidden')
      await form.setRecipient(recipient)
      await form.setInput('amountPlaceholder', '1')
      expect(form.destinationLookupCalls).toEqual(['checkVaultDestination'])
      expect(form.text()).toContain('Vault destination is forbidden')
      expect(form.button('buildTransaction').disabled).toBe(true)
      await form.directBuild()
      expect(form.calls).toHaveLength(0)
      await form.unmount()
      console.log(JSON.stringify({ contactFailureBuilds: 1, vaultFailureBuilds: 0 }))
    `
    const run = Bun.spawnSync([process.execPath, '--eval', source], {
      cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
    })
    if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
    expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!))
      .toEqual({ contactFailureBuilds: 1, vaultFailureBuilds: 0 })
  }, 35000)
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
