import type { Database } from 'bun:sqlite'

/** Additive migrations: never bump the destructive balance-cache schema version. */
export function migratePublicKeyCache(db: Database, table: 'balances' | 'pubkeys') {
  if (table === 'balances') {
    const columns = db.query('PRAGMA table_info(balances)').all() as { name: string }[]
    if (!columns.some(c => c.name === 'breakdown_json')) db.exec('ALTER TABLE balances ADD COLUMN breakdown_json TEXT')
    return
  }
  const columns = db.query('PRAGMA table_info(cached_pubkeys)').all() as { name: string; pk: number }[]
  if (columns.some(c => c.name === 'script_type' && c.pk > 0)) return
  db.transaction(() => {
    db.exec(`CREATE TABLE cached_pubkeys_v2 (
      device_id TEXT NOT NULL, chain_id TEXT NOT NULL, path TEXT NOT NULL DEFAULT '',
      xpub TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', script_type TEXT NOT NULL DEFAULT '',
      balance TEXT NOT NULL DEFAULT '0', balance_usd REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
      PRIMARY KEY (device_id, chain_id, path, script_type)
    )`)
    db.exec(`INSERT INTO cached_pubkeys_v2 SELECT device_id, chain_id, path, xpub, address, script_type, balance, balance_usd, updated_at FROM cached_pubkeys`)
    db.exec('DROP TABLE cached_pubkeys')
    db.exec('ALTER TABLE cached_pubkeys_v2 RENAME TO cached_pubkeys')
  })()
}
