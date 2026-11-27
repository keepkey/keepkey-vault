// KEEPKEY-176 (Audit v7 S7): saving a contact through its ENS name replaced the
// name the user gave it with the ENS name. The ENS name is only the fallback label.
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'vault-ens-label-'))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData: dir } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData: dir } }))
const db = await import('../src/bun/db')
const add = (address: string, extra: { label?: string | null; ensName?: string; cosigner?: boolean } = {}) => db.addExternalEntry({
  walletId: 'w', deviceId: 'd', networkId: 'eip155:1', chainId: 'ethereum', chainFamily: 'evm', address, ...extra,
})!

beforeAll(() => db.initDb())
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

describe('ENS saves keep the contact name (KEEPKEY-176)', () => {
  test('re-saving a named contact through its ENS name keeps the name and records the ENS name', () => {
    const address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
    add(address, { label: 'Vitalik pessoal' })
    const again = add(address, { label: null, ensName: 'vitalik.eth' })
    expect(again.label).toBe('Vitalik pessoal')
    expect(again.ensName).toBe('vitalik.eth')
  })

  test('a new ENS contact without a name is labeled with the ENS name', () => {
    const e = add('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', { label: null, ensName: 'alice.eth' })
    expect(e.label).toBe('alice.eth')
    expect(e.ensName).toBe('alice.eth')
  })

  test('a name typed with the save wins over the ENS name, new or existing', () => {
    expect(add('0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', { label: 'Bob', ensName: 'bob.eth' }).label).toBe('Bob')
    expect(add('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', { label: 'Alice', ensName: 'alice.eth' }).label).toBe('Alice')
  })

  test('a label that was only the old ENS name follows a new ENS name', () => {
    const address = '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB'
    add(address, { label: null, ensName: 'old.eth' })
    expect(add(address, { label: null, ensName: 'new.eth' }).label).toBe('new.eth')
  })

  test('re-saving an ENS contact by its address with no name keeps its name', () => {
    const address = '0x1Db3439a222C519ab44bb1144fC28167b4Fa6EE6'
    const e = add(address, { label: null, ensName: 'carol.eth' })
    db.updateAddressBookEntry(e.id, null, { label: 'Carol work' })
    // The addAddressBook handler passes a blank name as undefined.
    expect(add(address, { label: undefined }).label).toBe('Carol work')
  })

  test('the RPC handler and the Add address dialog no longer put the ENS name in the label', () => {
    const index = readFileSync(new URL('../src/bun/index.ts', import.meta.url), 'utf8')
    expect(index).not.toContain('label: ensName || params.label')
    // A blank name must reach db as undefined, or the ENS contact's name is cleared.
    expect(index).toContain('label: params.label?.trim() || undefined, ensName')
    const dialog = readFileSync(new URL('../src/mainview/components/AddAddressDialog.tsx', import.meta.url), 'utf8')
    expect(dialog).not.toContain('label: resolvedEns?.ensName ||')
  })
})
