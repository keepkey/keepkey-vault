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
