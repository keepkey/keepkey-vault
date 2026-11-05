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

mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('../src/bun/db')
const entry = (id: string) => db.getAddressBookList({}).find(e => e.id === id)!
const add = (address: string, extra: { label?: string; cosigner?: boolean; networkId?: string; chainId?: string } = {}) => db.addExternalEntry({
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
})
