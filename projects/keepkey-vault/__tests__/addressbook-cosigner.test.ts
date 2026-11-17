import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// An existing user's database, made before the co-signer flag existed, with a labeled contact.
const dir = mkdtempSync(join(tmpdir(), 'vault-cosigner-'))
const old = new Database(join(dir, 'vault.db'))
old.exec(`CREATE TABLE addressbook (
  id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL, device_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'external' CHECK(kind IN ('own','external')),
  network_id TEXT NOT NULL, chain_id TEXT NOT NULL, address TEXT NOT NULL,
  label TEXT, derivation_path TEXT, script_type TEXT, address_index INTEGER,
  first_seen_txid TEXT, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, saved_at INTEGER)`)
old.run(`INSERT INTO addressbook (id, wallet_id, device_id, kind, network_id, chain_id, address, label, created_at, updated_at, saved_at)
  VALUES ('old', 'w', 'd', 'external', 'eip155:8453', 'base', '0x1a6aae5495962c8f04f4a069a4cf59006416c541', 'Aurelian', 1, 1, 1)`)
old.close()

mock.module('electrobun/main', () => ({ Utils: { paths: { userData: dir } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData: dir } }))
const db = await import('../src/bun/db')
const entry = (id: string) => db.getAddressBookList({}).find(e => e.id === id)!
const add = (address: string, extra: { label?: string; ensName?: string; cosigner?: boolean; networkId?: string; chainId?: string; walletId?: string } = {}) => db.addExternalEntry({
  walletId: 'w', deviceId: 'd', networkId: 'eip155:8453', chainId: 'base', chainFamily: 'evm', address, ...extra,
})!

beforeAll(() => { db.initDb(); db.initDb() }) // the migration runs twice without error
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

describe('address book co-signer flag', () => {
  test("an existing user's contact survives the migration, unflagged", () => {
    const e = entry('old')
    expect(e.label).toBe('Aurelian')
    expect(e.savedAt).toBe(1)
    expect(e.cosigner).toBeUndefined()
  })

  test('saving a contact as a co-signer persists the flag', () => {
    expect(add('0x9768236c72F2EddE1A46aff6c1D85f5E252E6183', { label: 'Guilliman', cosigner: true }).cosigner).toBe(true)
  })

  test('re-saving the same address without the flag keeps it (a send-form save must not clear it)', () => {
    const again = add('0x9768236c72F2EddE1A46aff6c1D85f5E252E6183', { label: 'Guilliman' })
    expect(again.cosigner).toBe(true)
  })

  test('toggling the flag leaves the label and the book order alone', () => {
    const before = entry('old')
    expect(db.updateAddressBookEntry('old', null, { cosigner: true })).toBe(true)
    const after = entry('old')
    expect(after.cosigner).toBe(true)
    expect(after.label).toBe('Aurelian')
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(db.updateAddressBookEntry('old', null, { cosigner: false })).toBe(true)
    expect(entry('old').cosigner).toBeUndefined()
  })

  test('marking a saved contact as co-signer without a name keeps its name', () => {
    add('0x3da8816678866E23D0021E443e1a9Ec3b7190aD4', { label: 'Soren' })
    expect(add('0x3da8816678866E23D0021E443e1a9Ec3b7190aD4', { cosigner: true }).label).toBe('Soren')
  })

  test('the flag is one per address across EVM networks: unmarking on one clears the others', () => {
    const base = add('0x687405A3435c6799e0Fc78C68a005b970f39799c', { label: 'Horus', cosigner: true })
    const eth = add('0x687405A3435c6799e0Fc78C68a005b970f39799c', { label: 'Horus', networkId: 'eip155:1', chainId: 'ethereum' })
    expect(entry(eth.id).cosigner).toBe(true) // flagged on Base, so on Ethereum too
    expect(db.updateAddressBookEntry(eth.id, null, { cosigner: false })).toBe(true)
    expect(entry(base.id).cosigner).toBeUndefined()
  })

  test('a label edit does not touch the flag', () => {
    const g = add('0x9768236c72F2EddE1A46aff6c1D85f5E252E6183', { label: 'Guilliman' })
    expect(db.updateAddressBookEntry(g.id, null, { label: 'Guilliman (trading)' })).toBe(true)
    expect(entry(g.id).cosigner).toBe(true)
  })

  test("the flag belongs to the wallet that set it: another wallet's row for the address is untouched", () => {
    const addr = '0x687405A3435c6799e0Fc78C68a005b970f39799c'
    const mine = add(addr, { label: 'Horus', cosigner: true })
    const theirs = add(addr, { label: 'Horus', walletId: 'other' })
    expect(theirs.cosigner).toBeUndefined() // a new row does not inherit another wallet's flag
    db.updateAddressBookEntry(theirs.id, null, { cosigner: true })
    db.updateAddressBookEntry(mine.id, null, { cosigner: false })
    expect(entry(mine.id).cosigner).toBeUndefined()
    expect(entry(theirs.id).cosigner).toBe(true) // unmarking in one wallet does not clear another's
    // still one flag per address across EVM networks within a wallet
    expect(add(addr, { walletId: 'other', networkId: 'eip155:1', chainId: 'ethereum' }).cosigner).toBe(true)
  })
})

describe('ENS contact storage', () => {
  test('stores the resolved address, ENS label and provenance across rename and re-save', () => {
    const address = '0x4444444444444444444444444444444444444444'
    const e = add(address, { label: 'Ignored label', ensName: 'alice.eth' })
    expect(e.address).toBe(address)
    expect(e.label).toBe('alice.eth')
    expect(e.ensName).toBe('alice.eth')
    expect(e.isEns).toBe(true)
    expect(add(address).label).toBe('alice.eth')
    db.updateAddressBookEntry(e.id, null, { label: 'Alice savings' })
    expect(db.getAddressBookList({ search: 'alice.eth' }).map(e => e.id)).toContain(e.id)
    expect(add(address, { cosigner: true }).ensName).toBe('alice.eth')
  })

  test('does not store an unresolved name as an EVM address', () => {
    expect(add('unresolved.eth', { label: 'unresolved.eth' })).toBeNull()
  })

  test('repairs a legacy row in place and preserves history', () => {
    const database = db.getDb()!
    database.run(`INSERT INTO addressbook (id,wallet_id,device_id,kind,network_id,chain_id,address,label,saved_at,created_at,updated_at)
      VALUES ('legacy-ens','legacy-wallet','d','external','eip155:8453','base','bob.eth','Bob',1,1,1)`)
    db.recordOutbound({ walletId: 'legacy-wallet', deviceId: 'd', networkId: 'eip155:8453', chainId: 'base', chainFamily: 'evm',
      toAddress: 'bob.eth', caip: 'eip155:8453/slip44:60', txid: 'legacy-tx' })
    const legacy = entry('legacy-ens')
    expect(db.resolveStoredEnsContact(legacy, { ensName: 'bob.eth', address: '0x' + '5'.repeat(40) })).toBe(true)
    expect(entry('legacy-ens')).toMatchObject({ address: '0x' + '5'.repeat(40), label: 'bob.eth', ensName: 'bob.eth', isEns: true, savedAt: 1 })
    expect(db.getAddressBookHistory('legacy-ens', null).map(t => t.txid)).toEqual(['legacy-tx'])
    expect(db.resolveStoredEnsContact(legacy, { ensName: 'bob.eth', address: '0x' + '6'.repeat(40) })).toBe(false)
  })

  test('merges a legacy name into an existing address only within its wallet', () => {
    const address = '0x' + '7'.repeat(40)
    const target = add(address, { walletId: 'merge-wallet', label: 'Existing', cosigner: true })
    const other = add(address, { walletId: 'another-wallet', label: 'Other wallet' })
    db.getDb()!.run(`INSERT INTO addressbook (id,wallet_id,device_id,kind,network_id,chain_id,address,label,saved_at,created_at,updated_at)
      VALUES ('merge-ens','merge-wallet','d','external','eip155:8453','base','carol.eth','Carol',1,1,1)`)
    db.recordOutbound({ walletId: 'merge-wallet', deviceId: 'd', networkId: 'eip155:8453', chainId: 'base', chainFamily: 'evm',
      toAddress: 'carol.eth', caip: 'eip155:8453/slip44:60', txid: 'merged-tx' })
    expect(db.resolveStoredEnsContact(entry('merge-ens'), { ensName: 'carol.eth', address })).toBe(true)
    expect(entry(target.id)).toMatchObject({ address, label: 'carol.eth', isEns: true, cosigner: true })
    expect(db.getAddressBookHistory(target.id, null).map(t => t.txid)).toEqual(['merged-tx'])
    expect(entry('merge-ens')).toBeUndefined()
    expect(entry(other.id).label).toBe('Other wallet')
    expect(entry(other.id).isEns).toBeUndefined()
  })
})
