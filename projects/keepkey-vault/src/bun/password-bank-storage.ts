import type { Database } from 'bun:sqlite'

export function replaceEncryptedPasswordBank(db: Database, key: string, value: string, expected: string | null): boolean {
  if (db.inTransaction) throw new Error('Password bank must be saved in its own database transaction')

  // The rest of Vault uses NORMAL for its cache. Sync the password write to
  // the WAL before returning so a website change can proceed after this commit.
  const { synchronous } = db.query<{ synchronous: number }, []>('PRAGMA main.synchronous').get()!
  if (synchronous < 2) db.exec('PRAGMA main.synchronous = FULL')
  try {
    const result = expected === null
      ? db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', [key, value])
      : db.run('UPDATE settings SET value = ? WHERE key = ? AND value = ?', [value, key, expected])
    return result.changes === 1
  } finally {
    if (synchronous < 2) db.exec(`PRAGMA main.synchronous = ${synchronous}`)
  }
}
