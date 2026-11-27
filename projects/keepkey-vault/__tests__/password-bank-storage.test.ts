import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PasswordBank } from '../src/bun/password-bank'
import { replaceEncryptedPasswordBank } from '../src/bun/password-bank-storage'

test('database commit controls password release and keeps a changed password across a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepkey-password-bank-db-'))
  const path = join(dir, 'vault.db')
  const openDb = () => {
    const db = new Database(path)
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL')
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    return db
  }
  const openBank = (db: Database) => new PasswordBank({
    read: key => db.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null,
    write: (key, value) => { db.run('INSERT OR REPLACE INTO settings VALUES (?, ?)', [key, value]) },
    replace: (key, value, expected) => replaceEncryptedPasswordBank(db, key, value, expected),
    device: () => ({
      session: 'disposable-sqlite-test',
      cipher: async (path, label) => new Uint8Array(createHash('sha256').update(JSON.stringify({ path, label })).digest()),
    }),
  })

  let db = openDb()
  try {
    const bank = openBank(db)
    bank.setEnabled(true)
    await bank.unlock(true)
    await bank.generate(2, 5)
    const { id } = bank.assign('https://example.org', 'disposable test account', 90).profiles[0]
    const previous = bank.reveal(id).password

    db.exec("CREATE TRIGGER reject_bank_write BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'test database write failure'); END")
    expect(() => bank.change(id)).toThrow('test database write failure')
    expect(bank.reveal(id).password).toBe(previous)
    expect(db.query('PRAGMA main.synchronous').get()).toEqual({ synchronous: 1 })
    db.exec('DROP TRIGGER reject_bank_write')

    bank.change(id)
    const replacement = bank.reveal(id).password
    expect(replacement).not.toBe(previous)
    expect(db.query('PRAGMA main.synchronous').get()).toEqual({ synchronous: 1 })
    bank.lock()
    db.close()

    db = openDb()
    const restored = openBank(db)
    await restored.unlock()
    await restored.rehydrate(id, 5)
    expect(restored.reveal(id).password).toBe(replacement)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
