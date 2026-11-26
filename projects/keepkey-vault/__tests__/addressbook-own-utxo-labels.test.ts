/** Own UTXO keys used to be seeded as "LTC (xpub)" four times; untouched old
 *  defaults are renamed by script type on the next sync, user labels are kept. */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'vault-own-utxo-labels-'))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData: dir } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData: dir } }))
const db = await import('../src/bun/db')

beforeAll(() => db.initDb())
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

const scope = { deviceId: 'dev', walletId: 'w' }
const seed = (address: string, label: string, extra = {}) =>
  ({ address, networkId: 'bip122:12a765e31ffd4059bada1e25190f6e98', chainId: 'litecoin', chainFamily: 'utxo', symbol: 'LTC', label, ...extra })

test('old "(xpub)" defaults get the script-type label; renamed entries stay', () => {
  db.syncOwnAddressBook(scope, [seed('Ltub-legacy', 'LTC (xpub)'), seed('Ltub-mine', 'LTC (xpub)')])
  const mine = db.getAddressBookList({ walletId: 'w', kind: 'own' }).find(e => e.address === 'Ltub-mine')!
  db.updateAddressBookEntry(mine.id, 'w', { label: 'Savings' })

  const next = { replacesLabel: 'LTC (xpub)', scriptType: 'p2pkh' }
  db.syncOwnAddressBook(scope, [seed('Ltub-legacy', 'LTC Legacy', next), seed('Ltub-mine', 'LTC Legacy', next)])
  const rows = Object.fromEntries(db.getAddressBookList({ walletId: 'w', kind: 'own' }).map(e => [e.address, e]))
  expect(rows['Ltub-legacy'].label).toBe('LTC Legacy')
  expect(rows['Ltub-legacy'].scriptType).toBe('p2pkh')
  expect(rows['Ltub-mine'].label).toBe('Savings')
})
