/**
 * SQLite balance cache using bun:sqlite (built-in, zero deps).
 *
 * All functions are defensive — if the DB is null or throws, they return
 * null / no-op and log a warning. The app never crashes from cache failure.
 */
import { Database } from 'bun:sqlite'
import { Utils } from 'electrobun/bun'
import { join, dirname } from 'node:path'
import { mkdirSync, unlinkSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'crypto'
import type { ChainBalance, CustomToken, CustomChain, PairedAppInfo, ApiLogEntry, ReportMeta, ReportData, SwapHistoryRecord, SwapHistoryFilter, SwapTrackingStatus, SwapHistoryStats, Bip85SeedMeta, PioneerServer, AddressBookEntry, AddressBookTx, AddressBookFilter, AddressBookKind, ClearSignEvent } from '../shared/types'

const SCHEMA_VERSION = '10'

let db: Database | null = null

export function getDb(): Database | null { return db }

// ── Lifecycle ──────────────────────────────────────────────────────────

export function initDb() {
  // Strip BOM from version.json — PowerShell 5's -Encoding UTF8 writes a BOM (EF BB BF)
  // that breaks JSON.parse() in Electrobun's getVersionInfo(), preventing Utils.paths.userData
  // from resolving. Without this fix, SQLite never initializes on Windows.
  try {
    const versionJsonPath = join(dirname(process.argv0), '..', 'Resources', 'version.json')
    if (existsSync(versionJsonPath)) {
      const raw = readFileSync(versionJsonPath, 'utf-8')
      if (raw.charCodeAt(0) === 0xFEFF) {
        writeFileSync(versionJsonPath, raw.slice(1), 'utf-8')
        console.log('[db] Stripped BOM from version.json')
      }
    }
  } catch {}
  try {
    const dir = Utils.paths.userData
    mkdirSync(dir, { recursive: true })
    const dbPath = join(dir, 'vault.db')
    db = new Database(dbPath)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')

    // Schema versioning — bump SCHEMA_VERSION to nuke stale schema
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    const row = db.query('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | null
    if (row?.value !== SCHEMA_VERSION) {
      db.exec('DROP TABLE IF EXISTS balances')
      db.exec('DROP TABLE IF EXISTS pioneer_cache')
      db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, ['schema_version', SCHEMA_VERSION])
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS balances (
        device_id   TEXT NOT NULL,
        chain_id    TEXT NOT NULL,
        symbol      TEXT NOT NULL,
        balance     TEXT NOT NULL DEFAULT '0',
        balance_usd REAL NOT NULL DEFAULT 0,
        address     TEXT NOT NULL DEFAULT '',
        tokens_json TEXT,
        defi_positions_json TEXT,
        utxo_maturity_json TEXT,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (device_id, chain_id)
      )
    `)
    // Migration: add defi_positions_json for existing installs that
    // predate the GetPortfolioBalances includeDefi merge.
    try {
      db.exec(`ALTER TABLE balances ADD COLUMN defi_positions_json TEXT`)
    } catch { /* column already exists */ }
    try {
      db.exec(`ALTER TABLE balances ADD COLUMN utxo_maturity_json TEXT`)
    } catch { /* column already exists */ }

    db.exec(`
      CREATE TABLE IF NOT EXISTS pioneer_cache (
        cache_key  TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS custom_tokens (
        chain_id         TEXT NOT NULL,
        contract_address TEXT NOT NULL,
        symbol           TEXT NOT NULL,
        name             TEXT NOT NULL,
        decimals         INTEGER NOT NULL DEFAULT 18,
        network_id       TEXT NOT NULL,
        icon_url         TEXT,
        PRIMARY KEY (chain_id, contract_address)
      )
    `)
    // Migration for existing DBs created before icon_url. SQLite throws on
    // duplicate-column ADD; swallow that and propagate any other failure.
    try {
      db.exec(`ALTER TABLE custom_tokens ADD COLUMN icon_url TEXT`)
    } catch (e: any) {
      if (!String(e?.message || e).match(/duplicate column/i)) throw e
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS custom_chains (
        chain_id               INTEGER PRIMARY KEY,
        name                   TEXT NOT NULL,
        symbol                 TEXT NOT NULL,
        rpc_url                TEXT NOT NULL,
        explorer_url           TEXT,
        explorer_address_link  TEXT,
        explorer_tx_link       TEXT
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS paired_apps (
        api_key   TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        url       TEXT NOT NULL DEFAULT '',
        image_url TEXT NOT NULL DEFAULT '',
        added_on  INTEGER NOT NULL
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS token_visibility (
        caip       TEXT PRIMARY KEY,
        status     TEXT NOT NULL CHECK(status IN ('visible', 'hidden')),
        updated_at INTEGER NOT NULL
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS api_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id     TEXT,
        wallet_id     TEXT,
        method        TEXT NOT NULL,
        route         TEXT NOT NULL,
        timestamp     INTEGER NOT NULL,
        duration_ms   INTEGER NOT NULL DEFAULT 0,
        status        INTEGER NOT NULL,
        app_name      TEXT NOT NULL DEFAULT 'public',
        image_url     TEXT,
        request_body  TEXT,
        response_body TEXT
      )
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_api_log_ts ON api_log(timestamp DESC)`)

    db.exec(`
      CREATE TABLE IF NOT EXISTS device_snapshot (
        device_id     TEXT PRIMARY KEY,
        label         TEXT NOT NULL DEFAULT '',
        firmware_ver  TEXT NOT NULL DEFAULT '',
        features_json TEXT NOT NULL,
        updated_at    INTEGER NOT NULL
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS cached_pubkeys (
        device_id   TEXT NOT NULL,
        chain_id    TEXT NOT NULL,
        path        TEXT NOT NULL DEFAULT '',
        xpub        TEXT NOT NULL DEFAULT '',
        address     TEXT NOT NULL DEFAULT '',
        script_type TEXT NOT NULL DEFAULT '',
        balance     TEXT NOT NULL DEFAULT '0',
        balance_usd REAL NOT NULL DEFAULT 0,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (device_id, chain_id, path)
      )
    `)
    // Migration: add balance columns if missing (existing installs)
    try {
      db.exec(`ALTER TABLE cached_pubkeys ADD COLUMN balance TEXT NOT NULL DEFAULT '0'`)
    } catch { /* column already exists */ }
    try {
      db.exec(`ALTER TABLE cached_pubkeys ADD COLUMN balance_usd REAL NOT NULL DEFAULT 0`)
    } catch { /* column already exists */ }


    db.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id          TEXT PRIMARY KEY,
        device_id   TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        chain       TEXT NOT NULL DEFAULT 'all',
        lod         INTEGER NOT NULL DEFAULT 0,
        total_usd   REAL NOT NULL DEFAULT 0,
        status      TEXT NOT NULL DEFAULT 'complete',
        error       TEXT,
        data_json   TEXT NOT NULL
      )
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC)`)

    db.exec(`
      CREATE TABLE IF NOT EXISTS swap_history (
        id                  TEXT PRIMARY KEY,
        device_id           TEXT,
        wallet_id           TEXT,
        txid                TEXT NOT NULL,
        from_asset          TEXT NOT NULL,
        to_asset            TEXT NOT NULL,
        from_symbol         TEXT NOT NULL,
        to_symbol           TEXT NOT NULL,
        from_chain_id       TEXT NOT NULL,
        to_chain_id         TEXT NOT NULL,
        from_caip           TEXT,
        to_caip             TEXT,
        from_amount         TEXT NOT NULL,
        quoted_output       TEXT NOT NULL,
        minimum_output      TEXT NOT NULL DEFAULT '0',
        received_output     TEXT,
        slippage_bps        INTEGER NOT NULL DEFAULT 300,
        fee_bps             INTEGER NOT NULL DEFAULT 0,
        fee_outbound        TEXT NOT NULL DEFAULT '0',
        integration         TEXT NOT NULL DEFAULT 'thorchain',
        swapper             TEXT,
        memo                TEXT NOT NULL DEFAULT '',
        inbound_address     TEXT NOT NULL DEFAULT '',
        router              TEXT,
        status              TEXT NOT NULL DEFAULT 'pending',
        outbound_txid       TEXT,
        error               TEXT,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        completed_at        INTEGER,
        estimated_time_secs INTEGER NOT NULL DEFAULT 0,
        actual_time_secs    INTEGER,
        approval_txid       TEXT
      )
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_swap_history_created ON swap_history(created_at DESC)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_swap_history_status ON swap_history(status)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_swap_history_txid ON swap_history(txid)`)

    db.exec(`
      CREATE TABLE IF NOT EXISTS bip85_seeds (
        wallet_fingerprint TEXT NOT NULL,
        word_count         INTEGER NOT NULL,
        derivation_index   INTEGER NOT NULL,
        derivation_path    TEXT NOT NULL,
        label              TEXT NOT NULL DEFAULT '',
        created_at         INTEGER NOT NULL,
        PRIMARY KEY (wallet_fingerprint, word_count, derivation_index)
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS pioneer_servers (
        url        TEXT PRIMARY KEY,
        label      TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `)

    // Seed default Pioneer server if table is empty
    const serverCount = db.query('SELECT COUNT(*) as c FROM pioneer_servers').get() as { c: number } | null
    if (!serverCount || serverCount.c === 0) {
      db.run(
        'INSERT INTO pioneer_servers (url, label, is_default, created_at) VALUES (?, ?, 1, ?)',
        ['https://api.keepkey.info', 'KeepKey Official', Date.now()]
      )
    }

    // Per-emulator-wallet metadata (keyed by flash name, stable across re-imports).
    // Kept separate from device_snapshot so ephemeral emu identities never
    // contaminate the registered-device list and snapshots stay privacy-safe.
    db.exec(`
      CREATE TABLE IF NOT EXISTS emulator_wallet (
        name             TEXT PRIMARY KEY,
        label            TEXT NOT NULL DEFAULT '',
        device_id        TEXT NOT NULL DEFAULT '',
        firmware_version TEXT NOT NULL DEFAULT '',
        channel          TEXT NOT NULL DEFAULT '',
        updated_at       INTEGER NOT NULL
      )
    `)

    // Migrations: add columns to existing tables (safe to re-run)
    for (const col of ['explorer_address_link TEXT', 'explorer_tx_link TEXT']) {
      try { db.exec(`ALTER TABLE custom_chains ADD COLUMN ${col}`) } catch { /* already exists */ }
    }
    // Activity tracking columns on api_log (sign/broadcast ops)
    for (const col of ['txid TEXT', 'chain TEXT', 'activity_type TEXT', 'device_id TEXT', 'wallet_id TEXT']) {
      try { db.exec(`ALTER TABLE api_log ADD COLUMN ${col}`) } catch { /* already exists */ }
    }
    try { db.exec(`ALTER TABLE swap_history ADD COLUMN device_id TEXT`) } catch { /* already exists */ }
    // Pairing identity (stable per-install id) + sliding-TTL recency
    for (const col of ['client_id TEXT', 'last_used_on INTEGER']) {
      try { db.exec(`ALTER TABLE paired_apps ADD COLUMN ${col}`) } catch { /* already exists */ }
    }
    try { db.exec(`ALTER TABLE swap_history ADD COLUMN wallet_id TEXT`) } catch { /* already exists */ }
    // Underlying protocol when integration is an aggregator (e.g. Relay, 0x via ShapeShift)
    try { db.exec(`ALTER TABLE swap_history ADD COLUMN swapper TEXT`) } catch { /* already exists */ }
    // CAIPs for both sides — needed so the SwapDialog resume path can render
    // asset logos without a Pioneer round-trip.
    for (const col of ['from_caip TEXT', 'to_caip TEXT']) {
      try { db.exec(`ALTER TABLE swap_history ADD COLUMN ${col}`) } catch { /* already exists */ }
    }
    // Relay's bytes32 request id — drives the "Relay Track" external link.
    // Filled at trackSwap time via on-chain calldata, or lazily backfilled
    // by refreshSwap via api.relay.link for legacy rows.
    try { db.exec(`ALTER TABLE swap_history ADD COLUMN relay_request_id TEXT`) } catch { /* already exists */ }
    // Outbound chain truth from Maya midgard classifier — refunds outbound on
    // source chain, not destination. Without this column, history+activity
    // panels still resolve explorer URLs against toChainId and a refunded
    // ETH→ZEC opens a Zcash explorer for an ETH refund tx.
    for (const col of ['outbound_chain_id TEXT', 'refund_reason TEXT']) {
      try { db.exec(`ALTER TABLE swap_history ADD COLUMN ${col}`) } catch { /* already exists */ }
    }
    try { db.exec(`ALTER TABLE swap_history ADD COLUMN near_tx_hash TEXT`) } catch { /* already exists */ }
    // Inbound (input tx) on-chain location + timing from Pioneer's swap record
    // (blockchainTxData + confirmedAt + structured error). All best-effort; the
    // UI renders each conditionally. gas_used/effective_gas_price are EVM-only
    // (stored only when the input chain is eip155:* so UTXO vbytes never leak
    // in as "gas"). See HANDOFF-VAULT-SWAP-INPUT-BLOCK.
    for (const col of [
      'inbound_block_number INTEGER',
      'inbound_block_hash TEXT',
      'inbound_gas_used TEXT',
      'inbound_effective_gas_price TEXT',
      'inbound_confirmed_at INTEGER',
      'error_actionable TEXT',
      'error_elapsed_minutes INTEGER',
    ]) {
      try { db.exec(`ALTER TABLE swap_history ADD COLUMN ${col}`) } catch { /* already exists */ }
    }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_api_log_activity ON api_log(activity_type)`) } catch { /* already exists */ }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_api_log_device_ts ON api_log(device_id, timestamp DESC)`) } catch { /* already exists */ }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_api_log_wallet_ts ON api_log(wallet_id, timestamp DESC)`) } catch { /* already exists */ }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_swap_history_device_created ON swap_history(device_id, created_at DESC)`) } catch { /* already exists */ }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_swap_history_device_txid ON swap_history(device_id, txid)`) } catch { /* already exists */ }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_swap_history_wallet_created ON swap_history(wallet_id, created_at DESC)`) } catch { /* already exists */ }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_swap_history_wallet_txid ON swap_history(wallet_id, txid)`) } catch { /* already exists */ }

    // ── Address Book (additive — NEVER add to the SCHEMA_VERSION DROP block at
    //    db.ts:47-48; these hold irreplaceable user labels). Identity per row is
    //    (wallet_id, network_id, address). `kind` separates auto-seeded own-wallet
    //    rows (R2) from external recipients auto-created on send (R4). ──
    db.exec(`
      CREATE TABLE IF NOT EXISTS addressbook (
        id              TEXT PRIMARY KEY,
        wallet_id       TEXT NOT NULL,
        device_id       TEXT NOT NULL,
        kind            TEXT NOT NULL DEFAULT 'external' CHECK(kind IN ('own','external')),
        network_id      TEXT NOT NULL,
        chain_id        TEXT NOT NULL,
        address         TEXT NOT NULL,
        label           TEXT,
        derivation_path TEXT,
        script_type     TEXT,
        address_index   INTEGER,
        first_seen_txid TEXT,
        note            TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      )
    `)
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_addressbook_dedupe ON addressbook(wallet_id, network_id, address)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_addressbook_wallet_net ON addressbook(wallet_id, network_id)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_addressbook_device ON addressbook(device_id)`)
    // `saved_at` (R4 opt-in): null for external rows merely auto-recorded on send
    // (history-only, hidden from the book); set when the user explicitly saves the
    // contact. Backfill existing intentional rows — labeled, or manually added
    // (manual adds never carry a first_seen_txid) — so they aren't hidden.
    try { db.exec(`ALTER TABLE addressbook ADD COLUMN saved_at INTEGER`) } catch { /* already exists */ }
    try {
      db.exec(`UPDATE addressbook SET saved_at = COALESCE(saved_at, updated_at)
               WHERE kind = 'external' AND saved_at IS NULL
                 AND (label IS NOT NULL OR first_seen_txid IS NULL)`)
    } catch { /* best effort */ }

    db.exec(`
      CREATE TABLE IF NOT EXISTS addressbook_tx (
        id           TEXT PRIMARY KEY,
        entry_id     TEXT NOT NULL,
        wallet_id    TEXT NOT NULL,
        device_id    TEXT NOT NULL,
        txid         TEXT NOT NULL,
        from_address TEXT,
        caip         TEXT NOT NULL,
        symbol       TEXT,
        amount       TEXT,
        broadcast_at INTEGER NOT NULL
      )
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_addressbook_tx_entry ON addressbook_tx(entry_id, broadcast_at DESC)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_addressbook_tx_device ON addressbook_tx(device_id)`)

    // ── ClearSign Studio evidence (local-only, additive) ────────────────
    // Keep this independent from api_log: ClearSign evidence must survive
    // generic audit-log pruning and stores only the descriptor/attestation,
    // never a seed, private key, or full raw transaction.
    db.exec(`
      CREATE TABLE IF NOT EXISTS clearsign_events (
        id               TEXT PRIMARY KEY,
        created_at       INTEGER NOT NULL,
        device_id        TEXT,
        firmware_version TEXT,
        kind             TEXT NOT NULL,
        outcome          TEXT NOT NULL,
        source           TEXT NOT NULL,
        chain            TEXT,
        format           TEXT,
        label            TEXT,
        payload          TEXT,
        signature        TEXT,
        public_key       TEXT,
        fingerprint      TEXT,
        key_id           INTEGER,
        sent_to_device   INTEGER NOT NULL DEFAULT 0,
        request_json     TEXT,
        error            TEXT
      )
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_clearsign_events_created ON clearsign_events(created_at DESC)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_clearsign_events_device ON clearsign_events(device_id, created_at DESC)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_clearsign_events_outcome ON clearsign_events(outcome, created_at DESC)`)

    // ── Double-entry accounting ledger (additive — never dropped on version bump) ──
    db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_accounts (
        id         TEXT NOT NULL,
        device_id  TEXT NOT NULL,
        type       TEXT NOT NULL,
        asset      TEXT NOT NULL,
        chain_id   TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (id, device_id)
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS journal_entries (
        id          TEXT PRIMARY KEY,
        device_id   TEXT NOT NULL,
        description TEXT NOT NULL,
        entry_type  TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS postings (
        id               TEXT PRIMARY KEY,
        journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id),
        account_id       TEXT NOT NULL,
        amount           REAL NOT NULL,
        asset            TEXT NOT NULL,
        created_at       INTEGER NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_checkpoints (
        id          TEXT PRIMARY KEY,
        device_id   TEXT NOT NULL,
        name        TEXT NOT NULL,
        snapshot    TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      )
    `)
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_postings_account ON postings(account_id, asset)`) } catch { /* already exists */ }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_postings_journal ON postings(journal_entry_id)`) } catch { /* already exists */ }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_journal_entries_device ON journal_entries(device_id, created_at DESC)`) } catch { /* already exists */ }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_journal_entries_type ON journal_entries(device_id, entry_type)`) } catch { /* already exists */ }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_ledger_checkpoints_device ON ledger_checkpoints(device_id, created_at DESC)`) } catch { /* already exists */ }
    // Migrations — additive only, never drop
    try { db.exec(`ALTER TABLE journal_entries ADD COLUMN txid TEXT`) } catch { /* already exists */ }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_journal_entries_txid ON journal_entries(txid)`) } catch { /* already exists */ }
    // v10: rebuild ledger_accounts with composite PK (id, device_id) to fix per-device isolation.
    // The old table had id as sole PK, so the first device owned every account name forever.
    // Safe to drop: ledger data is fully re-derivable via POST /api/v1/ledger/replay.
    try {
      const hasBadPk = db.query(`SELECT COUNT(*) AS c FROM pragma_table_info('ledger_accounts') WHERE pk=1 AND name='id'`).get() as { c: number } | null
      if (hasBadPk?.c) {
        db.exec(`DROP TABLE IF EXISTS ledger_accounts_old`)
        db.exec(`ALTER TABLE ledger_accounts RENAME TO ledger_accounts_old`)
        db.exec(`CREATE TABLE ledger_accounts (
          id         TEXT NOT NULL,
          device_id  TEXT NOT NULL,
          type       TEXT NOT NULL,
          asset      TEXT NOT NULL,
          chain_id   TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (id, device_id)
        )`)
        db.exec(`INSERT INTO ledger_accounts SELECT id, device_id, type, asset, chain_id, created_at FROM ledger_accounts_old`)
        db.exec(`DROP TABLE ledger_accounts_old`)
        // Dependent postings are unaffected — account_id is still TEXT, no FK constraint to drop.
        console.log('[db] Migrated ledger_accounts to composite PK (id, device_id)')
      }
    } catch (e) { console.warn('[db] ledger_accounts v10 migration skipped:', e) }

    console.log(`[db] SQLite cache ready at ${dbPath}`)
  } catch (e: any) {
    console.warn('[db] Failed to init SQLite cache:', e.message)
    db = null
  }
}

export function closeDb() {
  try {
    db?.close()
  } catch { /* ignore */ }
  db = null
}

/** Delete the entire database file and re-initialize a fresh one.
 *  This is a full factory reset of all local app data including Zcash sidecar. */
export function factoryResetDb() {
  const dir = Utils.paths.userData
  const dbPath = join(dir, 'vault.db')
  // Close the current connection
  closeDb()
  // Remove vault DB file + WAL/SHM journals
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix
    try { if (existsSync(f)) unlinkSync(f) } catch { /* ignore */ }
  }
  console.log('[db] Factory reset — vault database deleted')

  // Remove Zcash sidecar wallet DB (~/.keepkey/zcash_wallet.db)
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (home) {
    const zcashDbPath = join(home, '.keepkey', 'zcash_wallet.db')
    for (const suffix of ['', '-wal', '-shm']) {
      const f = zcashDbPath + suffix
      try { if (existsSync(f)) unlinkSync(f) } catch { /* ignore */ }
    }
    console.log('[db] Factory reset — zcash sidecar database deleted')
  }

  // Re-create a fresh vault database
  initDb()
  console.log('[db] Factory reset — fresh database initialized')
}

// ── Balance Cache ──────────────────────────────────────────────────────

export function getCachedBalances(deviceId: string): { balances: ChainBalance[]; updatedAt: number } | null {
  try {
    if (!db) return null
    const rows = db.query(
      'SELECT chain_id, symbol, balance, balance_usd, address, tokens_json, defi_positions_json, utxo_maturity_json, updated_at FROM balances WHERE device_id = ?'
    ).all(deviceId) as Array<{ chain_id: string; symbol: string; balance: string; balance_usd: number; address: string; tokens_json: string | null; defi_positions_json: string | null; utxo_maturity_json: string | null; updated_at: number }>
    if (!rows || rows.length === 0) return null
    let maxUpdatedAt = 0
    const balances = rows.map(r => {
      if (r.updated_at > maxUpdatedAt) maxUpdatedAt = r.updated_at
      const entry: ChainBalance = {
        chainId: r.chain_id,
        symbol: r.symbol,
        balance: r.balance,
        balanceUsd: r.balance_usd,
        address: r.address,
        updatedAt: r.updated_at,
      }
      if (r.tokens_json) {
        try { entry.tokens = JSON.parse(r.tokens_json) } catch { /* corrupt JSON, skip tokens */ }
      }
      if (r.defi_positions_json) {
        try { entry.defiPositions = JSON.parse(r.defi_positions_json) } catch { /* corrupt JSON, skip defi */ }
      }
      if (r.utxo_maturity_json) {
        try { entry.utxoMaturity = JSON.parse(r.utxo_maturity_json) } catch { /* corrupt JSON, skip maturity */ }
      }
      // Native = balanceUsd − tokens − defi. We can't reconstruct it perfectly
      // because the live path doesn't separately persist nativeBalanceUsd, but
      // this matches how the live ChainBalance is constructed.
      const tokenUsdTotal = entry.tokens?.reduce((sum, t) => sum + (t.balanceUsd || 0), 0) || 0
      const defiUsdTotal = entry.defiPositions?.reduce((sum, p) => sum + (p.balanceUsd || 0), 0) || 0
      entry.nativeBalanceUsd = r.balance_usd - tokenUsdTotal - defiUsdTotal
      return entry
    })
    return { balances, updatedAt: maxUpdatedAt }
  } catch (e: any) {
    console.warn('[db] getCachedBalances failed:', e.message)
    return null
  }
}

// confirmedChainIds: chains where Pioneer returned a real response (even if balance=0).
// Confirmed entries write unconditionally — a genuine zero overwrites a stale non-zero.
// Unconfirmed entries (Pioneer failed/timed out for that chunk) keep the existing cached value.
export function setCachedBalances(deviceId: string, balances: ChainBalance[], confirmedChainIds?: Set<string>) {
  try {
    if (!db) return
    const now = Date.now()
    // Guarded upsert: keep existing non-zero if Pioneer didn't respond for this chain.
    const stmtGuarded = db.prepare(
      `INSERT INTO balances (device_id, chain_id, symbol, balance, balance_usd, address, tokens_json, defi_positions_json, utxo_maturity_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, chain_id) DO UPDATE SET
         symbol     = excluded.symbol,
         address    = CASE WHEN excluded.address != '' THEN excluded.address ELSE address END,
         balance    = CASE WHEN CAST(excluded.balance_usd AS REAL) > 0 THEN excluded.balance    ELSE balance    END,
         balance_usd= CASE WHEN CAST(excluded.balance_usd AS REAL) > 0 THEN excluded.balance_usd ELSE balance_usd END,
         tokens_json= CASE WHEN CAST(excluded.balance_usd AS REAL) > 0 THEN excluded.tokens_json ELSE tokens_json END,
         defi_positions_json = CASE WHEN CAST(excluded.balance_usd AS REAL) > 0 THEN excluded.defi_positions_json ELSE defi_positions_json END,
         utxo_maturity_json = CASE WHEN CAST(excluded.balance_usd AS REAL) > 0 THEN excluded.utxo_maturity_json ELSE utxo_maturity_json END,
         updated_at = CASE WHEN CAST(excluded.balance_usd AS REAL) > 0 THEN excluded.updated_at  ELSE updated_at  END`
    )
    // Forced upsert: Pioneer confirmed this chain — always write, even if balance=0.
    const stmtForced = db.prepare(
      `INSERT INTO balances (device_id, chain_id, symbol, balance, balance_usd, address, tokens_json, defi_positions_json, utxo_maturity_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, chain_id) DO UPDATE SET
         symbol      = excluded.symbol,
         address     = CASE WHEN excluded.address != '' THEN excluded.address ELSE address END,
         balance     = excluded.balance,
         balance_usd = excluded.balance_usd,
         tokens_json = excluded.tokens_json,
         defi_positions_json = excluded.defi_positions_json,
         utxo_maturity_json = excluded.utxo_maturity_json,
         updated_at  = excluded.updated_at`
    )
    const tx = db.transaction(() => {
      for (const b of balances) {
        const tokensJson = b.tokens && b.tokens.length > 0 ? JSON.stringify(b.tokens) : null
        const defiJson = b.defiPositions && b.defiPositions.length > 0 ? JSON.stringify(b.defiPositions) : null
        const maturityJson = b.utxoMaturity ? JSON.stringify(b.utxoMaturity) : null
        const args = [deviceId, b.chainId, b.symbol, b.balance, b.balanceUsd, b.address, tokensJson, defiJson, maturityJson, now] as const
        if (confirmedChainIds?.has(b.chainId)) {
          stmtForced.run(...args)
        } else {
          stmtGuarded.run(...args)
        }
      }
    })
    tx()
  } catch (e: any) {
    console.warn('[db] setCachedBalances failed:', e.message)
  }
}

/** Update a single chain's cached balance.
 *  Pass force=true when Pioneer confirmed the value — allows genuine zeros to overwrite stale data. */
export function updateCachedBalance(deviceId: string, balance: ChainBalance, force?: boolean) {
  try {
    if (!db) return
    const tokensJson = balance.tokens && balance.tokens.length > 0 ? JSON.stringify(balance.tokens) : null
    const defiJson = balance.defiPositions && balance.defiPositions.length > 0 ? JSON.stringify(balance.defiPositions) : null
    const maturityJson = balance.utxoMaturity ? JSON.stringify(balance.utxoMaturity) : null
    if (force) {
      db.run(
        `INSERT INTO balances (device_id, chain_id, symbol, balance, balance_usd, address, tokens_json, defi_positions_json, utxo_maturity_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id, chain_id) DO UPDATE SET
           symbol      = excluded.symbol,
           address     = CASE WHEN excluded.address != '' THEN excluded.address ELSE address END,
           balance     = excluded.balance,
           balance_usd = excluded.balance_usd,
           tokens_json = excluded.tokens_json,
           defi_positions_json = excluded.defi_positions_json,
           utxo_maturity_json = excluded.utxo_maturity_json,
           updated_at  = excluded.updated_at`,
        [deviceId, balance.chainId, balance.symbol, balance.balance, balance.balanceUsd, balance.address, tokensJson, defiJson, maturityJson, Date.now()]
      )
    } else {
      db.run(
        `INSERT INTO balances (device_id, chain_id, symbol, balance, balance_usd, address, tokens_json, defi_positions_json, utxo_maturity_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id, chain_id) DO UPDATE SET
           symbol     = excluded.symbol,
           address    = CASE WHEN excluded.address != '' THEN excluded.address ELSE address END,
           balance    = CASE WHEN CAST(excluded.balance_usd AS REAL) > 0 THEN excluded.balance    ELSE balance    END,
           balance_usd= CASE WHEN CAST(excluded.balance_usd AS REAL) > 0 THEN excluded.balance_usd ELSE balance_usd END,
           tokens_json= CASE WHEN CAST(excluded.balance_usd AS REAL) > 0 THEN excluded.tokens_json ELSE tokens_json END,
           defi_positions_json = CASE WHEN CAST(excluded.balance_usd AS REAL) > 0 THEN excluded.defi_positions_json ELSE defi_positions_json END,
           utxo_maturity_json = CASE WHEN CAST(excluded.balance_usd AS REAL) > 0 THEN excluded.utxo_maturity_json ELSE utxo_maturity_json END,
           updated_at = CASE WHEN CAST(excluded.balance_usd AS REAL) > 0 THEN excluded.updated_at  ELSE updated_at  END`,
        [deviceId, balance.chainId, balance.symbol, balance.balance, balance.balanceUsd, balance.address, tokensJson, defiJson, maturityJson, Date.now()]
      )
    }
  } catch (e: any) {
    console.warn('[db] updateCachedBalance failed:', e.message)
  }
}

export function clearBalances(deviceId?: string) {
  try {
    if (!db) return
    if (deviceId) {
      db.run('DELETE FROM balances WHERE device_id = ?', [deviceId])
    } else {
      db.run('DELETE FROM balances')
    }
  } catch (e: any) {
    console.warn('[db] clearBalances failed:', e.message)
  }
}

/** Remove one chain's cached balance for a device. Used when a chain becomes
 *  underivable on the current firmware (unknown-message) so a stale row cached
 *  under earlier firmware can't keep showing in the dashboard. */
export function deleteCachedChainBalance(deviceId: string, chainId: string) {
  try {
    if (!db) return
    db.run('DELETE FROM balances WHERE device_id = ? AND chain_id = ?', [deviceId, chainId])
  } catch (e: any) {
    console.warn('[db] deleteCachedChainBalance failed:', e.message)
  }
}

/** Purge every non-Bitcoin cached balance for a device. Used when the device
 *  runs bitcoin-only firmware — its seed is locked to BTC and it can't derive
 *  any other chain, so multi-chain balances cached from a prior firmware are
 *  phantom (they'd sum into "All Chains"). Returns rows removed. */
export function clearNonBitcoinBalances(deviceId: string): number {
  try {
    if (!db) return 0
    return db.run("DELETE FROM balances WHERE device_id = ? AND chain_id != 'bitcoin'", [deviceId]).changes
  } catch (e: any) {
    console.warn('[db] clearNonBitcoinBalances failed:', e.message)
    return 0
  }
}

// ── Custom Tokens ────────────────────────────────────────────────────

export function getCustomTokens(): CustomToken[] {
  try {
    if (!db) return []
    const rows = db.query('SELECT chain_id, contract_address, symbol, name, decimals, network_id, icon_url FROM custom_tokens').all() as Array<{
      chain_id: string; contract_address: string; symbol: string; name: string; decimals: number; network_id: string; icon_url: string | null
    }>
    return rows.map(r => ({
      chainId: r.chain_id,
      contractAddress: r.contract_address,
      symbol: r.symbol,
      name: r.name,
      decimals: r.decimals,
      networkId: r.network_id,
      iconUrl: r.icon_url || undefined,
    }))
  } catch (e: any) {
    console.warn('[db] getCustomTokens failed:', e.message)
    return []
  }
}

export function addCustomToken(token: CustomToken) {
  try {
    if (!db) return
    db.run(
      `INSERT OR REPLACE INTO custom_tokens (chain_id, contract_address, symbol, name, decimals, network_id, icon_url) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [token.chainId, token.contractAddress, token.symbol, token.name, token.decimals, token.networkId, token.iconUrl ?? null]
    )
  } catch (e: any) {
    console.warn('[db] addCustomToken failed:', e.message)
  }
}

export function removeCustomToken(chainId: string, contractAddress: string) {
  try {
    if (!db) return
    db.run('DELETE FROM custom_tokens WHERE chain_id = ? AND contract_address = ?', [chainId, contractAddress])
  } catch (e: any) {
    console.warn('[db] removeCustomToken failed:', e.message)
  }
}

export function setCustomTokenIcon(chainId: string, contractAddress: string, iconUrl: string): boolean {
  try {
    if (!db) return false
    const res = db.run('UPDATE custom_tokens SET icon_url = ? WHERE chain_id = ? AND contract_address = ?', [iconUrl, chainId, contractAddress])
    // bun:sqlite returns { changes } on .run(); guard for 0 changes (token row missing)
    return Boolean((res as any)?.changes)
  } catch (e: any) {
    console.warn('[db] setCustomTokenIcon failed:', e.message)
    return false
  }
}

// ── Custom Chains ────────────────────────────────────────────────────

export function getCustomChains(): CustomChain[] {
  try {
    if (!db) return []
    const rows = db.query('SELECT chain_id, name, symbol, rpc_url, explorer_url, explorer_address_link, explorer_tx_link FROM custom_chains').all() as Array<{
      chain_id: number; name: string; symbol: string; rpc_url: string; explorer_url: string | null; explorer_address_link: string | null; explorer_tx_link: string | null
    }>
    return rows.map(r => ({ chainId: r.chain_id, name: r.name, symbol: r.symbol, rpcUrl: r.rpc_url, explorerUrl: r.explorer_url || undefined, explorerAddressLink: r.explorer_address_link || undefined, explorerTxLink: r.explorer_tx_link || undefined }))
  } catch (e: any) {
    console.warn('[db] getCustomChains failed:', e.message)
    return []
  }
}

export function addCustomChainDb(chain: CustomChain) {
  try {
    if (!db) return
    db.run(
      `INSERT OR REPLACE INTO custom_chains (chain_id, name, symbol, rpc_url, explorer_url, explorer_address_link, explorer_tx_link) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [chain.chainId, chain.name, chain.symbol, chain.rpcUrl, chain.explorerUrl || null, chain.explorerAddressLink || null, chain.explorerTxLink || null]
    )
  } catch (e: any) {
    console.warn('[db] addCustomChain failed:', e.message)
  }
}

export function removeCustomChainDb(chainId: number) {
  try {
    if (!db) return
    db.run('DELETE FROM custom_chains WHERE chain_id = ?', [chainId])
  } catch (e: any) {
    console.warn('[db] removeCustomChain failed:', e.message)
  }
}

// ── App Settings (key-value) ────────────────────────────────────────

export function getSetting(key: string): string | null {
  try {
    if (!db) return null
    const row = db.query('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null
    return row?.value ?? null
  } catch (e: any) {
    console.warn('[db] getSetting failed:', e.message)
    return null
  }
}

export function setSetting(key: string, value: string) {
  try {
    if (!db) return
    db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value])
  } catch (e: any) {
    console.warn('[db] setSetting failed:', e.message)
  }
}

// ── Pioneer Servers ──────────────────────────────────────────────────

export function getPioneerServers(): PioneerServer[] {
  try {
    if (!db) return []
    const rows = db.query('SELECT url, label, is_default FROM pioneer_servers ORDER BY is_default DESC, created_at ASC').all() as Array<{
      url: string; label: string; is_default: number
    }>
    return rows.map(r => ({ url: r.url, label: r.label, isDefault: r.is_default === 1 }))
  } catch (e: any) {
    console.warn('[db] getPioneerServers failed:', e.message)
    return []
  }
}

export function addPioneerServerDb(url: string, label: string) {
  try {
    if (!db) return
    db.run(
      'INSERT OR REPLACE INTO pioneer_servers (url, label, is_default, created_at) VALUES (?, ?, 0, ?)',
      [url, label, Date.now()]
    )
  } catch (e: any) {
    console.warn('[db] addPioneerServer failed:', e.message)
  }
}

export function removePioneerServerDb(url: string) {
  try {
    if (!db) return
    // Prevent removing the default server
    const row = db.query('SELECT is_default FROM pioneer_servers WHERE url = ?').get(url) as { is_default: number } | null
    if (row?.is_default === 1) throw new Error('Cannot remove the default server')
    db.run('DELETE FROM pioneer_servers WHERE url = ?', [url])
  } catch (e: any) {
    console.warn('[db] removePioneerServer failed:', e.message)
    throw e
  }
}

// ── Token Visibility (spam filter user overrides) ─────────────────────

export type TokenVisibilityStatus = 'visible' | 'hidden'

export interface TokenVisibilityRow {
  caip: string
  status: TokenVisibilityStatus
  updatedAt: number
}

/** Get visibility status for a single token */
export function getTokenVisibility(caip: string): TokenVisibilityStatus | null {
  try {
    if (!db) return null
    const row = db.query('SELECT status FROM token_visibility WHERE caip = ?').get(caip.toLowerCase()) as { status: string } | null
    return (row?.status as TokenVisibilityStatus) ?? null
  } catch (e: any) {
    console.warn('[db] getTokenVisibility failed:', e.message)
    return null
  }
}

/** Get all user overrides as a Map<caip, status> */
export function getAllTokenVisibility(): Map<string, TokenVisibilityStatus> {
  const map = new Map<string, TokenVisibilityStatus>()
  try {
    if (!db) return map
    const rows = db.query('SELECT caip, status FROM token_visibility').all() as Array<{ caip: string; status: string }>
    for (const r of rows) map.set(r.caip, r.status as TokenVisibilityStatus)
  } catch (e: any) {
    console.warn('[db] getAllTokenVisibility failed:', e.message)
  }
  return map
}

/** Set visibility override for a token (upsert) */
export function setTokenVisibility(caip: string, status: TokenVisibilityStatus) {
  try {
    if (!db) return
    db.run(
      'INSERT OR REPLACE INTO token_visibility (caip, status, updated_at) VALUES (?, ?, ?)',
      [caip.toLowerCase(), status, Date.now()]
    )
  } catch (e: any) {
    console.warn('[db] setTokenVisibility failed:', e.message)
  }
}

/** Remove a user override (revert to auto-detection) */
export function removeTokenVisibility(caip: string) {
  try {
    if (!db) return
    db.run('DELETE FROM token_visibility WHERE caip = ?', [caip.toLowerCase()])
  } catch (e: any) {
    console.warn('[db] removeTokenVisibility failed:', e.message)
  }
}

/** Get all tokens with a given status */
export function getTokensByVisibility(status: TokenVisibilityStatus): TokenVisibilityRow[] {
  try {
    if (!db) return []
    const rows = db.query('SELECT caip, status, updated_at FROM token_visibility WHERE status = ?').all(status) as Array<{
      caip: string; status: string; updated_at: number
    }>
    return rows.map(r => ({ caip: r.caip, status: r.status as TokenVisibilityStatus, updatedAt: r.updated_at }))
  } catch (e: any) {
    console.warn('[db] getTokensByVisibility failed:', e.message)
    return []
  }
}

// ── Paired Apps ──────────────────────────────────────────────────────

export function getStoredPairings(): PairedAppInfo[] {
  try {
    if (!db) return []
    const rows = db.query('SELECT api_key, name, url, image_url, added_on, client_id, last_used_on FROM paired_apps').all() as Array<{
      api_key: string; name: string; url: string; image_url: string; added_on: number; client_id: string | null; last_used_on: number | null
    }>
    return rows.map(r => ({
      apiKey: r.api_key, name: r.name, url: r.url, imageUrl: r.image_url, addedOn: r.added_on,
      clientId: r.client_id ?? undefined, lastUsedOn: r.last_used_on ?? undefined,
    }))
  } catch (e: any) {
    console.warn('[db] getStoredPairings failed:', e.message)
    return []
  }
}

export function storePairing(apiKey: string, info: { name: string; url: string; imageUrl: string; addedOn: number; clientId?: string; lastUsedOn?: number }) {
  try {
    if (!db) return
    db.run(
      'INSERT OR REPLACE INTO paired_apps (api_key, name, url, image_url, added_on, client_id, last_used_on) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [apiKey, info.name, info.url || '', info.imageUrl || '', info.addedOn, info.clientId ?? null, info.lastUsedOn ?? info.addedOn]
    )
  } catch (e: any) {
    console.warn('[db] storePairing failed:', e.message)
  }
}

/** Lightweight recency write-back — used by the sliding-TTL refresh on the auth
 *  hot path, so it must not rewrite the whole row. No-op if the row is gone. */
export function touchPairing(apiKey: string, lastUsedOn: number) {
  try {
    if (!db) return
    db.run('UPDATE paired_apps SET last_used_on = ? WHERE api_key = ?', [lastUsedOn, apiKey])
  } catch (e: any) {
    console.warn('[db] touchPairing failed:', e.message)
  }
}

export function removePairing(apiKey: string) {
  try {
    if (!db) return
    db.run('DELETE FROM paired_apps WHERE api_key = ?', [apiKey])
  } catch (e: any) {
    console.warn('[db] removePairing failed:', e.message)
  }
}

export function clearPairings() {
  try {
    if (!db) return
    db.run('DELETE FROM paired_apps')
  } catch (e: any) {
    console.warn('[db] clearPairings failed:', e.message)
  }
}

// ── ClearSign Studio evidence ─────────────────────────────────────────

export type NewClearSignEvent = Omit<ClearSignEvent, 'id' | 'createdAt'> & {
  id?: string
  createdAt?: number
}

/** Persist one local ClearSign result and return the exact stored shape. */
export function insertClearSignEvent(input: NewClearSignEvent): ClearSignEvent {
  const entry: ClearSignEvent = {
    ...input,
    id: input.id || randomUUID(),
    createdAt: input.createdAt || Date.now(),
  }
  try {
    if (!db) return entry
    db.run(
      `INSERT INTO clearsign_events (
        id, created_at, device_id, firmware_version, kind, outcome, source,
        chain, format, label, payload, signature, public_key, fingerprint,
        key_id, sent_to_device, request_json, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.createdAt,
        entry.deviceId || null,
        entry.firmwareVersion || null,
        entry.kind,
        entry.outcome,
        entry.source,
        entry.chain || null,
        entry.format || null,
        entry.label || null,
        entry.payload || null,
        entry.signature || null,
        entry.publicKey || null,
        entry.fingerprint || null,
        entry.keyId ?? null,
        entry.sentToDevice ? 1 : 0,
        entry.request ? JSON.stringify(entry.request) : null,
        entry.error || null,
      ],
    )
  } catch (e: any) {
    console.warn('[db] insertClearSignEvent failed:', e.message)
  }
  return entry
}

export function getClearSignEvents(filter: {
  limit?: number
  deviceId?: string
  outcome?: ClearSignEvent['outcome']
} = {}): ClearSignEvent[] {
  try {
    if (!db) return []
    const clauses: string[] = []
    const values: Array<string | number> = []
    if (filter.deviceId) {
      clauses.push('device_id = ?')
      values.push(filter.deviceId)
    }
    if (filter.outcome) {
      clauses.push('outcome = ?')
      values.push(filter.outcome)
    }
    const limit = Math.max(1, Math.min(1000, Math.floor(filter.limit || 250)))
    values.push(limit)
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = db.query(
      `SELECT id, created_at, device_id, firmware_version, kind, outcome, source,
              chain, format, label, payload, signature, public_key, fingerprint,
              key_id, sent_to_device, request_json, error
         FROM clearsign_events ${where}
        ORDER BY created_at DESC LIMIT ?`,
    ).all(...values) as Array<Record<string, any>>
    return rows.map((row) => {
      let request: Record<string, unknown> | undefined
      if (row.request_json) {
        try { request = JSON.parse(row.request_json) } catch { /* corrupt row: omit request */ }
      }
      return {
        id: row.id,
        createdAt: row.created_at,
        deviceId: row.device_id || undefined,
        firmwareVersion: row.firmware_version || undefined,
        kind: row.kind,
        outcome: row.outcome,
        source: row.source,
        chain: row.chain || undefined,
        format: row.format || undefined,
        label: row.label || undefined,
        payload: row.payload || undefined,
        signature: row.signature || undefined,
        publicKey: row.public_key || undefined,
        fingerprint: row.fingerprint || undefined,
        keyId: row.key_id ?? undefined,
        sentToDevice: row.sent_to_device === 1,
        request,
        error: row.error || undefined,
      } as ClearSignEvent
    })
  } catch (e: any) {
    console.warn('[db] getClearSignEvents failed:', e.message)
    return []
  }
}

// ── API Audit Log ──────────────────────────────────────────────────────

const MAX_API_LOG_ROWS = 5000
const REDACTED_API_LOG_KEYS = new Set(['apiKey'])

function parseApiLogJson(raw: string | null): any {
  if (!raw) return undefined
  try {
    return redactApiLogValue(JSON.parse(raw))
  } catch {
    return undefined
  }
}

function redactApiLogValue(value: any, depth = 0): any {
  if (!value || typeof value !== 'object' || depth > 8) return value
  if (Array.isArray(value)) return value.map(v => redactApiLogValue(v, depth + 1))
  const out: any = {}
  for (const [key, child] of Object.entries(value)) {
    if (REDACTED_API_LOG_KEYS.has(key)) {
      out[key] = '[trimmed]'
    } else {
      out[key] = redactApiLogValue(child, depth + 1)
    }
  }
  return out
}

/** Insert an API log entry and prune old rows beyond MAX_API_LOG_ROWS */
export function insertApiLog(entry: ApiLogEntry) {
  try {
    if (!db) return
    db.run(
      `INSERT INTO api_log (device_id, wallet_id, method, route, timestamp, duration_ms, status, app_name, image_url, request_body, response_body, txid, chain, activity_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.deviceId || null,
        entry.walletId || null,
        entry.method,
        entry.route,
        entry.timestamp,
        entry.durationMs,
        entry.status,
        entry.appName,
        entry.imageUrl || null,
        entry.requestBody ? JSON.stringify(entry.requestBody) : null,
        entry.responseBody ? JSON.stringify(entry.responseBody) : null,
        entry.txid || null,
        entry.chain || null,
        entry.activityType || null,
      ]
    )
    // Periodic prune (every ~100 inserts). Keep rebuilt chain-history rows;
    // cap only generic API audit noise so a full wallet rebuild cannot be
    // hollowed out by /docs, balance, or address polling entries.
    if (Math.random() < 0.01) {
      db.run(
        `DELETE FROM api_log
          WHERE method <> 'SCAN'
            AND id NOT IN (
              SELECT id FROM api_log
              WHERE method <> 'SCAN'
              ORDER BY timestamp DESC
              LIMIT ?
            )`,
        [MAX_API_LOG_ROWS],
      )
    }
  } catch (e: any) {
    console.warn('[db] insertApiLog failed:', e.message)
  }
}

/** Get recent API log entries (newest first) */
export function getApiLogs(limit = 200, offset = 0, deviceId?: string, walletId?: string): ApiLogEntry[] {
  try {
    if (!db) return []
    const whereSql = walletId ? 'WHERE wallet_id = ?' : deviceId ? 'WHERE device_id = ?' : ''
    const scopeArgs = walletId ? [walletId] : deviceId ? [deviceId] : []
    const args = [...scopeArgs, limit, offset]
    const rows = db.query(
      `SELECT id, device_id, wallet_id, method, route, timestamp, duration_ms, status, app_name, image_url, request_body, response_body FROM api_log ${whereSql} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(...args) as Array<{
      id: number; device_id: string | null; wallet_id: string | null; method: string; route: string; timestamp: number; duration_ms: number;
      status: number; app_name: string; image_url: string | null;
      request_body: string | null; response_body: string | null
    }>
    return rows.map(r => ({
      id: r.id,
      deviceId: r.device_id || undefined,
      walletId: r.wallet_id || undefined,
      method: r.method,
      route: r.route,
      timestamp: r.timestamp,
      durationMs: r.duration_ms,
      status: r.status,
      appName: r.app_name,
      imageUrl: r.image_url || undefined,
      requestBody: parseApiLogJson(r.request_body),
      responseBody: parseApiLogJson(r.response_body),
    }))
  } catch (e: any) {
    console.warn('[db] getApiLogs failed:', e.message)
    return []
  }
}

/** Clear all API logs */
export function clearApiLogs(deviceId?: string, walletId?: string) {
  try {
    if (!db) return
    if (walletId) db.run('DELETE FROM api_log WHERE wallet_id = ?', [walletId])
    else if (deviceId) db.run('DELETE FROM api_log WHERE device_id = ?', [deviceId])
    else db.run('DELETE FROM api_log')
  } catch (e: any) {
    console.warn('[db] clearApiLogs failed:', e.message)
  }
}

export interface ApiLogFilter {
  deviceId?: string
  walletId?: string
  route?: string
  activityType?: string
  txid?: string
  chain?: string
  since?: number
  until?: number
  limit?: number
  offset?: number
}

/** Filtered query over api_log (newest first). Returns full request/response bodies. */
export function findApiLogs(filter: ApiLogFilter = {}): ApiLogEntry[] {
  try {
    if (!db) return []
    const where: string[] = []
    const args: any[] = []
    if (filter.walletId)     { where.push('wallet_id = ?');     args.push(filter.walletId) }
    if (filter.deviceId)     { where.push('device_id = ?');     args.push(filter.deviceId) }
    if (filter.route)        { where.push('route = ?');         args.push(filter.route) }
    if (filter.activityType) { where.push('activity_type = ?'); args.push(filter.activityType) }
    if (filter.txid)         { where.push('txid = ?');          args.push(filter.txid) }
    if (filter.chain)        { where.push('chain = ?');         args.push(filter.chain) }
    if (filter.since)        { where.push('timestamp >= ?');    args.push(filter.since) }
    if (filter.until)        { where.push('timestamp <= ?');    args.push(filter.until) }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
    const offset = Math.max(filter.offset ?? 0, 0)
    const rows = db.query(
      `SELECT id, method, route, timestamp, duration_ms, status, app_name, image_url,
              request_body, response_body, txid, chain, activity_type, device_id, wallet_id
       FROM api_log ${whereSql}
       ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(...args, limit, offset) as Array<any>
    return rows.map(r => ({
      id: r.id,
      deviceId: r.device_id || undefined,
      walletId: r.wallet_id || undefined,
      method: r.method,
      route: r.route,
      timestamp: r.timestamp,
      durationMs: r.duration_ms,
      status: r.status,
      appName: r.app_name,
      imageUrl: r.image_url || undefined,
      requestBody: parseApiLogJson(r.request_body),
      responseBody: parseApiLogJson(r.response_body),
      txid: r.txid || undefined,
      chain: r.chain || undefined,
      activityType: r.activity_type || undefined,
    }))
  } catch (e: any) {
    console.warn('[db] findApiLogs failed:', e.message)
    return []
  }
}

/** Single api_log entry by id with full bodies. */
export function getApiLogById(id: number, deviceId?: string, walletId?: string): ApiLogEntry | null {
  try {
    if (!db) return null
    const whereSql = walletId ? 'id = ? AND wallet_id = ?' : deviceId ? 'id = ? AND device_id = ?' : 'id = ?'
    const args = walletId ? [id, walletId] : deviceId ? [id, deviceId] : [id]
    const r: any = db.query(
      `SELECT id, method, route, timestamp, duration_ms, status, app_name, image_url,
              request_body, response_body, txid, chain, activity_type, device_id, wallet_id
       FROM api_log WHERE ${whereSql} LIMIT 1`
    ).get(...args)
    if (!r) return null
    return {
      id: r.id,
      deviceId: r.device_id || undefined,
      walletId: r.wallet_id || undefined,
      method: r.method,
      route: r.route,
      timestamp: r.timestamp,
      durationMs: r.duration_ms,
      status: r.status,
      appName: r.app_name,
      imageUrl: r.image_url || undefined,
      requestBody: parseApiLogJson(r.request_body),
      responseBody: parseApiLogJson(r.response_body),
      txid: r.txid || undefined,
      chain: r.chain || undefined,
      activityType: r.activity_type || undefined,
    }
  } catch (e: any) {
    console.warn('[db] getApiLogById failed:', e.message)
    return null
  }
}


// ── Recent Activity (unified from api_log + swap_history) ─────────────

import type { RecentActivity, ActivityType, ActivitySource } from '../shared/types'

/** Check if a rebuilt scan row already exists in api_log. */
export function apiLogScanTxidExists(txid: string, deviceId?: string, walletId?: string): boolean {
  try {
    if (!db) return false
    const row = walletId
      ? db.query("SELECT 1 FROM api_log WHERE txid = ? AND wallet_id = ? AND method = 'SCAN' LIMIT 1").get(txid, walletId)
      : deviceId
      ? db.query("SELECT 1 FROM api_log WHERE txid = ? AND device_id = ? AND method = 'SCAN' LIMIT 1").get(txid, deviceId)
      : db.query("SELECT 1 FROM api_log WHERE txid = ? AND method = 'SCAN' LIMIT 1").get(txid)
    return !!row
  } catch { return false }
}

/** Update metadata for an existing rebuilt scan row. */
export function updateApiLogTxMeta(
  txid: string,
  meta: Record<string, any>,
  deviceId?: string,
  walletId?: string,
  activity?: { activityType?: string; chain?: string; route?: string; timestamp?: number },
) {
  try {
    if (!db) return
    const setSql: string[] = ['response_body = ?']
    const args: any[] = [JSON.stringify(meta)]
    if (activity?.activityType) { setSql.push('activity_type = ?'); args.push(activity.activityType) }
    if (activity?.chain) { setSql.push('chain = ?'); args.push(activity.chain) }
    if (activity?.route) { setSql.push('route = ?'); args.push(activity.route) }
    if (activity?.timestamp) { setSql.push('timestamp = ?'); args.push(activity.timestamp) }

    if (walletId) db.run(`UPDATE api_log SET ${setSql.join(', ')} WHERE txid = ? AND wallet_id = ? AND method = 'SCAN'`, [...args, txid, walletId])
    else if (deviceId) db.run(`UPDATE api_log SET ${setSql.join(', ')} WHERE txid = ? AND device_id = ? AND method = 'SCAN'`, [...args, txid, deviceId])
    else db.run(`UPDATE api_log SET ${setSql.join(', ')} WHERE txid = ? AND method = 'SCAN'`, [...args, txid])
  } catch (e: any) {
    console.warn('[db] updateApiLogTxMeta failed:', e.message)
  }
}

const VALID_ACTIVITY_TYPES = new Set(['send', 'receive', 'swap', 'sign', 'message', 'approve', 'broadcast', 'shield', 'unshield'])

/** Query api_log entries that have activity_type set + swap_history, merged by timestamp */
// Collapse two api_log rows describing the SAME on-chain txid into one record
// (e.g. an in-app RPC 'broadcast' row + the Pioneer SCAN row). The primary row
// OWNS the amount/source pairing — these must stay together because scan amounts
// are base units while app/api amounts are human, and crossing them breaks
// display formatting. We prefer an explicit app/api send as primary (clean human
// amount + recipient) and overlay only the on-chain truth the primary can't know
// (confirmations / block height / counterparty) from the scan row.
function mergeTxRows(a: RecentActivity, b: RecentActivity): RecentActivity {
  const primary = a.source !== 'scan' ? a : b.source !== 'scan' ? b : a
  const secondary = primary === a ? b : a
  return {
    ...primary,
    confirmations: primary.confirmations ?? secondary.confirmations,
    blockHeight: primary.blockHeight || secondary.blockHeight || undefined,
    from: primary.from ?? secondary.from,
    to: primary.to ?? secondary.to,
  }
}

export function getRecentActivityFromLog(limit = 50, chainFilter?: string, deviceId?: string, walletId?: string): RecentActivity[] {
  try {
    if (!db) return []

    // Build query with optional chain filter
    let logSql = `SELECT id, device_id, wallet_id, txid, chain, activity_type, app_name, timestamp, route, method, response_body
       FROM api_log WHERE activity_type IS NOT NULL`
    const logParams: any[] = []
    if (walletId) {
      logSql += ` AND wallet_id = ?`
      logParams.push(walletId)
    }
    if (deviceId) {
      logSql += ` AND device_id = ?`
      logParams.push(deviceId)
    }
    if (chainFilter) {
      logSql += ` AND (chain = ? OR route = ? OR response_body LIKE ?)`
      logParams.push(chainFilter, `history/${chainFilter}`, `%"chainId":"${chainFilter}"%`)
    }
    // Over-fetch: an in-app send and the Pioneer scan of the same tx are two
    // rows that get merged below. Fetching only `limit` rows would let those
    // duplicates shrink the deduped result below `limit` and hide older unique
    // rows. 3x covers the worst realistic per-txid row count with headroom.
    logSql += ` ORDER BY timestamp DESC LIMIT ?`
    logParams.push(limit * 3)

    const logRows = db.query(logSql).all(...logParams) as Array<{
      id: number; device_id: string | null; wallet_id: string | null; txid: string | null; chain: string | null; activity_type: string;
      app_name: string; timestamp: number; route: string; method: string; response_body: string | null
    }>

    const rawLogActivities: RecentActivity[] = logRows.map(r => {
      // Parse tx metadata from response_body (stored by scan)
      let meta: any = null
      if (r.response_body) { try { meta = JSON.parse(r.response_body) } catch {} }
      const isScan = r.method === 'SCAN'
      return {
        id: String(r.id),
        deviceId: r.device_id || undefined,
        walletId: r.wallet_id || undefined,
        txid: r.txid || undefined,
        chain: meta?.chainSymbol || r.chain || '?',
        chainId: meta?.chainId ?? undefined,
        type: (VALID_ACTIVITY_TYPES.has(r.activity_type) ? (r.activity_type === 'broadcast' ? 'send' : r.activity_type) : 'sign') as ActivityType,
        source: isScan ? 'scan' : (r.method === 'RPC' ? 'app' : 'api') as ActivitySource,
        appName: r.method === 'RPC' ? undefined : (isScan ? undefined : r.app_name),
        status: isScan ? 'broadcast' : (['broadcast', 'swap', 'shield', 'unshield'].includes(r.activity_type) ? 'broadcast' : 'signed'),
        createdAt: r.timestamp,
        confirmations: meta?.confirmations ?? undefined,
        blockHeight: meta?.blockHeight ?? undefined,
        amount: meta?.value ?? undefined,
        fee: meta?.fee ?? undefined,
        to: meta?.to ?? undefined,
        from: meta?.from ?? undefined,
        asset: meta?.asset ?? undefined,
      }
    })

    // Swap history entries (dedupe by txid against logActivities)
    let swapSql = `SELECT id, device_id, wallet_id, txid, from_symbol, to_symbol, from_chain_id, to_chain_id,
       from_caip, to_caip, from_amount, quoted_output, received_output, status, created_at
       FROM swap_history`
    const swapParams: any[] = []
    const swapWhere: string[] = []
    if (walletId) {
      swapWhere.push(`wallet_id = ?`)
      swapParams.push(walletId)
    }
    if (deviceId) {
      swapWhere.push(`device_id = ?`)
      swapParams.push(deviceId)
    }
    if (chainFilter) {
      // Match swap by either source or destination chain (e.g. ETH->BTC visible under both ETH and BTC)
      swapWhere.push(`(from_symbol = ? OR to_symbol = ? OR from_chain_id = ? OR to_chain_id = ?)`)
      swapParams.push(chainFilter, chainFilter, chainFilter, chainFilter)
    }
    if (swapWhere.length) swapSql += ` WHERE ${swapWhere.join(' AND ')}`
    swapSql += ` ORDER BY created_at DESC LIMIT ?`
    swapParams.push(limit)

    const swapRows = db.query(swapSql).all(...swapParams) as Array<{
      id: string; device_id: string | null; wallet_id: string | null; txid: string; from_symbol: string; to_symbol: string;
      from_chain_id: string; to_chain_id: string;
      from_caip: string | null; to_caip: string | null;
      from_amount: string; quoted_output: string; received_output: string | null;
      status: string; created_at: number
    }>

    const swapLogTxids = new Set(rawLogActivities.filter(a => a.type === 'swap' && a.txid).map(a => a.txid))
    const swapRowTxids = new Set(swapRows.filter(r => r.txid).map(r => r.txid))
    const allSwapTxids = new Set([...swapLogTxids, ...swapRowTxids])
    const filteredLog = rawLogActivities.filter(a => !(a.txid && a.type !== 'swap' && allSwapTxids.has(a.txid)))
    // Dedupe by txid: an in-app send and the Pioneer scan of the same tx each
    // produce a row — merge them into one complete record instead of two.
    const byTxid = new Map<string, RecentActivity>()
    const noTxid: RecentActivity[] = []
    const txidOrder: string[] = []
    for (const a of filteredLog) {
      if (!a.txid) { noTxid.push(a); continue }
      const existing = byTxid.get(a.txid)
      if (existing) byTxid.set(a.txid, mergeTxRows(existing, a))
      else { byTxid.set(a.txid, a); txidOrder.push(a.txid) }
    }
    const logActivities = [...noTxid, ...txidOrder.map(t => byTxid.get(t)!)]
    const swapActivities: RecentActivity[] = swapRows
      .filter(r => !swapLogTxids.has(r.txid))
      .map(r => ({
        id: r.id,
        deviceId: r.device_id || undefined,
        walletId: r.wallet_id || undefined,
        txid: r.txid,
        chain: r.from_symbol,
        chainId: r.from_chain_id,
        type: 'swap' as const,
        source: 'app' as const,
        amount: r.from_amount,
        asset: r.from_symbol,
        outAmount: r.received_output || r.quoted_output || undefined,
        outAsset: r.to_symbol,
        outChainId: r.to_chain_id,
        fromCaip: r.from_caip || undefined,
        toCaip: r.to_caip || undefined,
        status: r.status === 'completed' ? 'completed' as const : r.status === 'failed' ? 'failed' as const : r.status === 'refunded' ? 'refunded' as const : 'broadcast' as const,
        swapStatus: r.status as any,
        createdAt: r.created_at,
      }))

    return [...logActivities, ...swapActivities]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
  } catch (e: any) {
    console.warn('[db] getRecentActivityFromLog failed:', e.message)
    return []
  }
}

// ── Device Snapshot (watch-only cache) ──────────────────────────────

export function saveDeviceSnapshot(deviceId: string, label: string, firmwareVer: string, featuresJson: string) {
  try {
    if (!db) return
    db.run(
      `INSERT OR REPLACE INTO device_snapshot (device_id, label, firmware_ver, features_json, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [deviceId, label, firmwareVer, featuresJson, Date.now()]
    )
  } catch (e: any) {
    console.warn('[db] saveDeviceSnapshot failed:', e.message)
  }
}

export function getLatestDeviceSnapshot(): { deviceId: string; label: string; firmwareVer: string; featuresJson: string; updatedAt: number } | null {
  try {
    if (!db) return null
    const row = db.query(
      'SELECT device_id, label, firmware_ver, features_json, updated_at FROM device_snapshot ORDER BY updated_at DESC LIMIT 1'
    ).get() as { device_id: string; label: string; firmware_ver: string; features_json: string; updated_at: number } | null
    if (!row) return null
    return { deviceId: row.device_id, label: row.label, firmwareVer: row.firmware_ver, featuresJson: row.features_json, updatedAt: row.updated_at }
  } catch (e: any) {
    console.warn('[db] getLatestDeviceSnapshot failed:', e.message)
    return null
  }
}

export function getDeviceSnapshotById(deviceId: string): { deviceId: string; label: string; firmwareVer: string; featuresJson: string; updatedAt: number } | null {
  try {
    if (!db) return null
    const row = db.query(
      'SELECT device_id, label, firmware_ver, features_json, updated_at FROM device_snapshot WHERE device_id = ?'
    ).get(deviceId) as { device_id: string; label: string; firmware_ver: string; features_json: string; updated_at: number } | null
    if (!row) return null
    return { deviceId: row.device_id, label: row.label, firmwareVer: row.firmware_ver, featuresJson: row.features_json, updatedAt: row.updated_at }
  } catch (e: any) {
    console.warn('[db] getDeviceSnapshotById failed:', e.message)
    return null
  }
}

export function getAllDeviceSnapshots(): Array<{ deviceId: string; label: string; firmwareVer: string; updatedAt: number; totalUsd: number }> {
  try {
    if (!db) return []
    const rows = db.query(`
      SELECT s.device_id, s.label, s.firmware_ver, s.updated_at,
             COALESCE(SUM(b.balance_usd), 0) AS total_usd
      FROM device_snapshot s
      LEFT JOIN balances b ON b.device_id = s.device_id
      GROUP BY s.device_id
      ORDER BY s.updated_at DESC
    `).all() as Array<{ device_id: string; label: string; firmware_ver: string; updated_at: number; total_usd: number }>
    return rows.map(r => ({ deviceId: r.device_id, label: r.label, firmwareVer: r.firmware_ver, updatedAt: r.updated_at, totalUsd: r.total_usd }))
  } catch (e: any) {
    console.warn('[db] getAllDeviceSnapshots failed:', e.message)
    return []
  }
}

export function deleteDeviceSnapshot(deviceId: string) {
  try {
    if (!db) return
    db.run('DELETE FROM device_snapshot WHERE device_id = ?', [deviceId])
    db.run('DELETE FROM cached_pubkeys WHERE device_id = ?', [deviceId])
    db.run('DELETE FROM balances WHERE device_id = ?', [deviceId])
    db.run('DELETE FROM reports WHERE device_id = ?', [deviceId])
    db.run('DELETE FROM api_log WHERE device_id = ?', [deviceId])
    db.run('DELETE FROM swap_history WHERE device_id = ?', [deviceId])
    db.run('DELETE FROM addressbook WHERE device_id = ?', [deviceId])
    db.run('DELETE FROM addressbook_tx WHERE device_id = ?', [deviceId])
  } catch (e: any) {
    console.warn('[db] deleteDeviceSnapshot failed:', e.message)
  }
}

// ── Emulator Wallet Metadata ────────────────────────────────────────

export interface EmulatorWalletMeta {
  name: string
  label: string
  deviceId: string
  firmwareVersion: string
  channel: string
  updatedAt: number
  totalUsd: number
}

export function saveEmulatorWalletMeta(name: string, label: string, deviceId: string, firmwareVersion: string, channel: string) {
  try {
    if (!db) return
    db.run(
      `INSERT OR REPLACE INTO emulator_wallet (name, label, device_id, firmware_version, channel, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [name, label, deviceId, firmwareVersion, channel, Date.now()]
    )
  } catch (e: any) {
    console.warn('[db] saveEmulatorWalletMeta failed:', e.message)
  }
}

export function getAllEmulatorWalletMeta(): EmulatorWalletMeta[] {
  try {
    if (!db) return []
    const rows = db.query(`
      SELECT w.name, w.label, w.device_id, w.firmware_version, w.channel, w.updated_at,
             COALESCE(SUM(b.balance_usd), 0) AS total_usd
      FROM emulator_wallet w
      LEFT JOIN balances b ON b.device_id = w.device_id
      GROUP BY w.name
    `).all() as Array<{ name: string; label: string; device_id: string; firmware_version: string; channel: string; updated_at: number; total_usd: number }>
    return rows.map(r => ({
      name: r.name,
      label: r.label,
      deviceId: r.device_id,
      firmwareVersion: r.firmware_version,
      channel: r.channel,
      updatedAt: r.updated_at,
      totalUsd: r.total_usd,
    }))
  } catch (e: any) {
    console.warn('[db] getAllEmulatorWalletMeta failed:', e.message)
    return []
  }
}

export function deleteEmulatorWalletMeta(name: string) {
  try {
    if (!db) return
    db.run('DELETE FROM emulator_wallet WHERE name = ?', [name])
  } catch (e: any) {
    console.warn('[db] deleteEmulatorWalletMeta failed:', e.message)
  }
}

// ── Cached Pubkeys (watch-only address cache) ───────────────────────

export function saveCachedPubkey(deviceId: string, chainId: string, path: string, xpub: string, address: string, scriptType: string, balance?: string, balanceUsd?: number, force?: boolean) {
  try {
    if (!db) return
    if (force) {
      db.run(
        `INSERT INTO cached_pubkeys (device_id, chain_id, path, xpub, address, script_type, balance, balance_usd, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id, chain_id, path) DO UPDATE SET
           xpub        = excluded.xpub,
           address     = CASE WHEN excluded.address != '' THEN excluded.address ELSE address END,
           script_type = excluded.script_type,
           balance     = excluded.balance,
           balance_usd = excluded.balance_usd,
           updated_at  = excluded.updated_at`,
        [deviceId, chainId, path || '', xpub || '', address || '', scriptType || '', balance || '0', balanceUsd ?? 0, Date.now()]
      )
    } else {
      db.run(
        `INSERT INTO cached_pubkeys (device_id, chain_id, path, xpub, address, script_type, balance, balance_usd, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id, chain_id, path) DO UPDATE SET
           xpub        = excluded.xpub,
           address     = CASE WHEN excluded.address != '' THEN excluded.address ELSE address END,
           script_type = excluded.script_type,
           balance     = CASE WHEN CAST(excluded.balance_usd AS REAL) > 0 THEN excluded.balance     ELSE balance     END,
           balance_usd = CASE WHEN CAST(excluded.balance_usd AS REAL) > 0 THEN excluded.balance_usd ELSE balance_usd END,
           updated_at  = CASE WHEN CAST(excluded.balance_usd AS REAL) > 0 THEN excluded.updated_at  ELSE updated_at  END`,
        [deviceId, chainId, path || '', xpub || '', address || '', scriptType || '', balance || '0', balanceUsd ?? 0, Date.now()]
      )
    }
  } catch (e: any) {
    console.warn('[db] saveCachedPubkey failed:', e.message)
  }
}

export function getCachedPubkeys(deviceId: string): Array<{ chainId: string; path: string; xpub: string; address: string; scriptType: string; balance: string; balanceUsd: number }> {
  try {
    if (!db) return []
    const rows = db.query(
      'SELECT chain_id, path, xpub, address, script_type, balance, balance_usd FROM cached_pubkeys WHERE device_id = ?'
    ).all(deviceId) as Array<{ chain_id: string; path: string; xpub: string; address: string; script_type: string; balance: string; balance_usd: number }>
    return rows.map(r => ({ chainId: r.chain_id, path: r.path, xpub: r.xpub, address: r.address, scriptType: r.script_type, balance: r.balance || '0', balanceUsd: r.balance_usd || 0 }))
  } catch (e: any) {
    console.warn('[db] getCachedPubkeys failed:', e.message)
    return []
  }
}

/** Clear all cached pubkeys for a device (e.g. when passphrase changes the seed). */
export function clearCachedPubkeys(deviceId: string) {
  try {
    if (!db) return
    db.run('DELETE FROM cached_pubkeys WHERE device_id = ?', [deviceId])
    console.log(`[db] Cleared cached pubkeys for device ${deviceId}`)
  } catch (e: any) {
    console.warn('[db] clearCachedPubkeys failed:', e.message)
  }
}

// ── Reports ──────────────────────────────────────────────────────────

const MAX_REPORTS = 50

export function saveReport(deviceId: string, id: string, chain: string, lod: number, totalUsd: number, status: string, dataJson: string, error?: string) {
  try {
    if (!db) return
    db.run(
      `INSERT OR REPLACE INTO reports (id, device_id, created_at, chain, lod, total_usd, status, error, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, deviceId, Date.now(), chain, lod, totalUsd, status, error || null, dataJson]
    )
    // Prune old reports beyond MAX_REPORTS per device
    try {
      db.run(
        `DELETE FROM reports WHERE device_id = ? AND id NOT IN (
          SELECT id FROM reports WHERE device_id = ? ORDER BY created_at DESC LIMIT ?
        )`,
        [deviceId, deviceId, MAX_REPORTS]
      )
    } catch { /* pruning is best-effort */ }
  } catch (e: any) {
    console.warn('[db] saveReport failed:', e.message)
  }
}

export function getReportsList(deviceId: string, limit = 20): ReportMeta[] {
  try {
    if (!db) return []
    const rows = db.query(
      'SELECT id, created_at, chain, lod, total_usd, status, error FROM reports WHERE device_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(deviceId, limit) as Array<{ id: string; created_at: number; chain: string; lod: number; total_usd: number; status: string; error: string | null }>
    return rows.map(r => ({
      id: r.id,
      createdAt: r.created_at,
      chain: r.chain,
      totalUsd: r.total_usd,
      status: r.status as ReportMeta['status'],
      error: r.error || undefined,
    }))
  } catch (e: any) {
    console.warn('[db] getReportsList failed:', e.message)
    return []
  }
}

export function getReportById(id: string, deviceId?: string): { meta: ReportMeta; data: ReportData } | null {
  try {
    if (!db) return null
    const query = deviceId
      ? 'SELECT id, created_at, chain, lod, total_usd, status, error, data_json FROM reports WHERE id = ? AND device_id = ?'
      : 'SELECT id, created_at, chain, lod, total_usd, status, error, data_json FROM reports WHERE id = ?'
    const params = deviceId ? [id, deviceId] : [id]
    const row = db.query(query).get(...params) as { id: string; created_at: number; chain: string; lod: number; total_usd: number; status: string; error: string | null; data_json: string } | null
    if (!row) return null
    const meta: ReportMeta = {
      id: row.id,
      createdAt: row.created_at,
      chain: row.chain,
      totalUsd: row.total_usd,
      status: row.status as ReportMeta['status'],
      error: row.error || undefined,
    }
    let data: ReportData
    try {
      data = JSON.parse(row.data_json)
    } catch {
      console.warn(`[db] Report ${id} has corrupted JSON data`)
      return { meta: { ...meta, status: 'error', error: 'Report data corrupted' }, data: { title: 'Corrupted Report', subtitle: '', generatedDate: '', sections: [] } }
    }
    return { meta, data }
  } catch (e: any) {
    console.warn('[db] getReportById failed:', e.message)
    return null
  }
}

export function deleteReport(id: string, deviceId?: string) {
  try {
    if (!db) return
    if (deviceId) {
      db.run('DELETE FROM reports WHERE id = ? AND device_id = ?', [id, deviceId])
    } else {
      db.run('DELETE FROM reports WHERE id = ?', [id])
    }
  } catch (e: any) {
    console.warn('[db] deleteReport failed:', e.message)
  }
}

export function reportExists(id: string): boolean {
  try {
    if (!db) return false
    const row = db.query('SELECT 1 FROM reports WHERE id = ?').get(id)
    return !!row
  } catch {
    return false
  }
}

// ── Swap History ──────────────────────────────────────────────────────

/** Insert a new swap history record (called when swap is first tracked) */
export function insertSwapHistory(record: SwapHistoryRecord) {
  try {
    if (!db) return
    db.run(
      `INSERT OR REPLACE INTO swap_history
        (id, device_id, wallet_id, txid, from_asset, to_asset, from_symbol, to_symbol, from_chain_id, to_chain_id,
         from_caip, to_caip, from_amount, quoted_output, minimum_output, received_output, slippage_bps, fee_bps,
         fee_outbound, integration, swapper, memo, inbound_address, router, status, outbound_txid,
         error, created_at, updated_at, completed_at, estimated_time_secs, actual_time_secs, approval_txid,
         relay_request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id, record.deviceId || null, record.walletId || null, record.txid, record.fromAsset, record.toAsset,
        record.fromSymbol, record.toSymbol, record.fromChainId, record.toChainId,
        record.fromCaip || null, record.toCaip || null,
        record.fromAmount, record.quotedOutput, record.minimumOutput,
        record.receivedOutput || null,
        record.slippageBps, record.feeBps, record.feeOutbound,
        record.integration, record.swapper || null, record.memo, record.inboundAddress,
        record.router || null, record.status, record.outboundTxid || null,
        record.error || null, record.createdAt, record.updatedAt,
        record.completedAt || null, record.estimatedTimeSeconds,
        record.actualTimeSeconds || null, record.approvalTxid || null,
        record.relayRequestId || null,
      ]
    )
  } catch (e: any) {
    console.warn('[db] insertSwapHistory failed:', e.message)
  }
}

/** Update swap status and related fields (called on every status change).
 *
 *  Field semantics:
 *  - Truthy values UPDATE the column.
 *  - `null` values explicitly CLEAR the column (UPDATE … SET col = NULL).
 *  - `undefined` (or field absent) leaves the column unchanged.
 *  This three-state distinction matters for `swapper` — once the tracker has
 *  identified a swap as native-vault (mayachain/thorchain) it needs to wipe
 *  any stale "thorchain" value Pioneer wrote earlier; an undefined-skip
 *  pattern would silently fail and leave the badge mis-rendering.
 */
export function updateSwapHistoryStatus(
  txid: string,
  status: SwapTrackingStatus,
  extra?: {
    deviceId?: string
    walletId?: string
    outboundTxid?: string | null
    outboundChainId?: string | null
    refundReason?: string | null
    error?: string
    receivedOutput?: string
    swapper?: string | null
    completedAt?: number
    actualTimeSeconds?: number
    nearTxHash?: string
    inboundBlockNumber?: number
    inboundBlockHash?: string
    inboundGasUsed?: string
    inboundEffectiveGasPrice?: string
    inboundConfirmedAt?: number
    errorActionable?: string
    errorElapsedMinutes?: number
  }
) {
  try {
    if (!db) return
    const now = Date.now()
    const isFinal = status === 'completed' || status === 'failed' || status === 'refunded'

    // Build SET clauses and params together to prevent misalignment
    const setClauses: Array<{ col: string; value: any }> = [
      { col: 'status', value: status },
      { col: 'updated_at', value: now },
    ]

    // Three-state writers: truthy → set, null → clear, undefined → skip.
    const writeNullable = (col: string, val: string | null | undefined) => {
      if (val === undefined) return
      setClauses.push({ col, value: val ?? null })
    }
    writeNullable('outbound_txid', extra?.outboundTxid)
    writeNullable('outbound_chain_id', extra?.outboundChainId)
    writeNullable('refund_reason', extra?.refundReason)
    writeNullable('swapper', extra?.swapper)
    if (extra?.nearTxHash) setClauses.push({ col: 'near_tx_hash', value: extra.nearTxHash })
    if (extra?.error) setClauses.push({ col: 'error', value: extra.error })
    if (extra?.receivedOutput) setClauses.push({ col: 'received_output', value: extra.receivedOutput })
    // Inbound block + timing + structured-error fields — only written when the
    // poll actually carries them (undefined → column unchanged), so a later
    // rescan that drops blockHash can't null out a value an earlier poll set.
    if (extra?.inboundBlockNumber !== undefined) setClauses.push({ col: 'inbound_block_number', value: extra.inboundBlockNumber })
    if (extra?.inboundBlockHash) setClauses.push({ col: 'inbound_block_hash', value: extra.inboundBlockHash })
    if (extra?.inboundGasUsed) setClauses.push({ col: 'inbound_gas_used', value: extra.inboundGasUsed })
    if (extra?.inboundEffectiveGasPrice) setClauses.push({ col: 'inbound_effective_gas_price', value: extra.inboundEffectiveGasPrice })
    if (extra?.inboundConfirmedAt !== undefined) setClauses.push({ col: 'inbound_confirmed_at', value: extra.inboundConfirmedAt })
    if (extra?.errorActionable) setClauses.push({ col: 'error_actionable', value: extra.errorActionable })
    if (extra?.errorElapsedMinutes !== undefined) setClauses.push({ col: 'error_elapsed_minutes', value: extra.errorElapsedMinutes })
    if (isFinal) {
      setClauses.push({ col: 'completed_at', value: extra?.completedAt || now })
      if (extra?.actualTimeSeconds !== undefined) {
        setClauses.push({ col: 'actual_time_secs', value: extra.actualTimeSeconds })
      }
    }

    const where = extra?.walletId ? 'txid = ? AND wallet_id = ?' : extra?.deviceId ? 'txid = ? AND device_id = ?' : 'txid = ?'
    const params = extra?.walletId
      ? [...setClauses.map(c => c.value), txid, extra.walletId]
      : extra?.deviceId
        ? [...setClauses.map(c => c.value), txid, extra.deviceId]
        : [...setClauses.map(c => c.value), txid]
    const sql = `UPDATE swap_history SET ${setClauses.map(c => `${c.col} = ?`).join(', ')} WHERE ${where}`

    db.run(sql, params)
  } catch (e: any) {
    console.warn('[db] updateSwapHistoryStatus failed:', e.message)
  }
}

/** Query swap history with optional filters */
export function getSwapHistory(filter?: SwapHistoryFilter): SwapHistoryRecord[] {
  try {
    if (!db) return []

    let sql = `SELECT * FROM swap_history WHERE 1=1`
    const params: any[] = []

    if (filter?.status && filter.status !== 'all') {
      sql += ` AND status = ?`
      params.push(filter.status)
    }
    if (filter?.deviceId) {
      sql += ` AND device_id = ?`
      params.push(filter.deviceId)
    }
    if (filter?.walletId) {
      sql += ` AND wallet_id = ?`
      params.push(filter.walletId)
    }
    if (filter?.fromDate) {
      sql += ` AND created_at >= ?`
      params.push(filter.fromDate)
    }
    if (filter?.toDate) {
      sql += ` AND created_at <= ?`
      params.push(filter.toDate)
    }
    if (filter?.asset) {
      sql += ` AND (from_symbol LIKE ? ESCAPE '\\' OR to_symbol LIKE ? ESCAPE '\\' OR from_asset LIKE ? ESCAPE '\\' OR to_asset LIKE ? ESCAPE '\\')`
      const escaped = filter.asset.replace(/[\\%_]/g, c => '\\' + c)
      const q = `%${escaped}%`
      params.push(q, q, q, q)
    }

    sql += ` ORDER BY created_at DESC`

    const limit = filter?.limit || 100
    const offset = filter?.offset || 0
    sql += ` LIMIT ? OFFSET ?`
    params.push(limit, offset)

    const rows = db.query(sql).all(...params) as any[]
    return rows.map(mapSwapRow)
  } catch (e: any) {
    console.warn('[db] getSwapHistory failed:', e.message)
    return []
  }
}

/** Get a single swap history record by txid */
export function getSwapHistoryByTxid(txid: string, deviceId?: string, walletId?: string): SwapHistoryRecord | null {
  try {
    if (!db) return null
    const row = walletId
      ? db.query('SELECT * FROM swap_history WHERE txid = ? AND wallet_id = ?').get(txid, walletId) as any
      : deviceId
      ? db.query('SELECT * FROM swap_history WHERE txid = ? AND device_id = ?').get(txid, deviceId) as any
      : db.query('SELECT * FROM swap_history WHERE txid = ?').get(txid) as any
    return row ? mapSwapRow(row) : null
  } catch (e: any) {
    console.warn('[db] getSwapHistoryByTxid failed:', e.message)
    return null
  }
}

/** Get aggregate stats for swap history */
export function getSwapHistoryStats(deviceId?: string, walletId?: string): SwapHistoryStats {
  try {
    if (!db) return { totalSwaps: 0, completed: 0, failed: 0, refunded: 0, pending: 0 }
    const whereSql = walletId ? 'WHERE wallet_id = ?' : deviceId ? 'WHERE device_id = ?' : ''
    const args = walletId ? [walletId] : deviceId ? [deviceId] : []
    const row = db.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) as refunded,
        SUM(CASE WHEN status NOT IN ('completed', 'failed', 'refunded') THEN 1 ELSE 0 END) as pending
      FROM swap_history
      ${whereSql}
    `).get(...args) as any
    return {
      totalSwaps: row?.total || 0,
      completed: row?.completed || 0,
      failed: row?.failed || 0,
      refunded: row?.refunded || 0,
      pending: row?.pending || 0,
    }
  } catch (e: any) {
    console.warn('[db] getSwapHistoryStats failed:', e.message)
    return { totalSwaps: 0, completed: 0, failed: 0, refunded: 0, pending: 0 }
  }
}

function mapSwapRow(r: any): SwapHistoryRecord {
  return {
    id: r.id,
    deviceId: r.device_id || undefined,
    walletId: r.wallet_id || undefined,
    txid: r.txid,
    fromAsset: r.from_asset,
    toAsset: r.to_asset,
    fromSymbol: r.from_symbol,
    toSymbol: r.to_symbol,
    fromChainId: r.from_chain_id,
    toChainId: r.to_chain_id,
    fromCaip: r.from_caip || undefined,
    toCaip: r.to_caip || undefined,
    fromAmount: r.from_amount,
    quotedOutput: r.quoted_output,
    minimumOutput: r.minimum_output,
    receivedOutput: r.received_output || undefined,
    slippageBps: r.slippage_bps,
    feeBps: r.fee_bps,
    feeOutbound: r.fee_outbound,
    integration: r.integration,
    swapper: r.swapper || undefined,
    memo: r.memo,
    inboundAddress: r.inbound_address,
    router: r.router || undefined,
    status: r.status as SwapTrackingStatus,
    outboundTxid: r.outbound_txid || undefined,
    error: r.error || undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at || undefined,
    estimatedTimeSeconds: r.estimated_time_secs,
    actualTimeSeconds: r.actual_time_secs || undefined,
    approvalTxid: r.approval_txid || undefined,
    relayRequestId: r.relay_request_id || undefined,
    outboundChainId: r.outbound_chain_id || undefined,
    refundReason: r.refund_reason || undefined,
    nearTxHash: r.near_tx_hash || undefined,
    inboundBlockNumber: r.inbound_block_number ?? undefined,
    inboundBlockHash: r.inbound_block_hash || undefined,
    inboundGasUsed: r.inbound_gas_used || undefined,
    inboundEffectiveGasPrice: r.inbound_effective_gas_price || undefined,
    inboundConfirmedAt: r.inbound_confirmed_at ?? undefined,
    errorActionable: r.error_actionable || undefined,
    errorElapsedMinutes: r.error_elapsed_minutes ?? undefined,
  }
}

/** Backfill the Relay request id on an existing row (called when refreshSwap
 *  resolves it lazily via api.relay.link for a legacy swap). */
export function setSwapRelayRequestId(txid: string, relayRequestId: string, deviceId?: string, walletId?: string) {
  try {
    if (!db) return
    if (walletId) db.run('UPDATE swap_history SET relay_request_id = ? WHERE txid = ? AND wallet_id = ?', [relayRequestId, txid, walletId])
    else if (deviceId) db.run('UPDATE swap_history SET relay_request_id = ? WHERE txid = ? AND device_id = ?', [relayRequestId, txid, deviceId])
    else db.run('UPDATE swap_history SET relay_request_id = ? WHERE txid = ?', [relayRequestId, txid])
  } catch (e: any) {
    console.warn('[db] setSwapRelayRequestId failed:', e.message)
  }
}

// ── Address Book ────────────────────────────────────────────────────
// Unified, top-level contact + own-wallet book. Identity = (wallet_id,
// network_id, address). All write paths normalize the address (EVM lowercased)
// so a checksummed paste and a lowercase paste never create duplicate rows.

/** Normalize an address for storage/dedupe. EVM is case-insensitive and must be
 *  lowercased; every other family is case-sensitive and stored verbatim. */
export function normalizeAddress(address: string, chainFamily: string): string {
  return chainFamily === 'evm' ? address.toLowerCase() : address
}

function mapAddressBookRow(r: any): AddressBookEntry {
  return {
    id: r.id,
    walletId: r.wallet_id,
    deviceId: r.device_id,
    kind: r.kind as AddressBookKind,
    networkId: r.network_id,
    chainId: r.chain_id,
    address: r.address,
    label: r.label || undefined,
    derivationPath: r.derivation_path || undefined,
    scriptType: r.script_type || undefined,
    addressIndex: r.address_index ?? undefined,
    firstSeenTxid: r.first_seen_txid || undefined,
    note: r.note || undefined,
    savedAt: r.saved_at ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function mapAddressBookTxRow(r: any): AddressBookTx {
  return {
    id: r.id,
    entryId: r.entry_id,
    txid: r.txid,
    fromAddress: r.from_address || undefined,
    caip: r.caip,
    symbol: r.symbol || undefined,
    amount: r.amount || undefined,
    broadcastAt: r.broadcast_at,
  }
}

export interface OwnAddressSeed {
  address: string
  networkId: string
  chainId: string
  chainFamily: string
  symbol: string
  label: string
  derivationPath?: string
  scriptType?: string
  addressIndex?: number
}

/** Idempotently mirror connected-wallet addresses as kind='own' entries (R2).
 *  INSERT OR IGNORE on the dedupe key, so a user-renamed own entry is never
 *  clobbered by a later re-sync. Returns the number of NEW rows inserted. */
export function syncOwnAddressBook(
  scope: { deviceId: string; walletId: string },
  seeds: OwnAddressSeed[],
): number {
  try {
    if (!db || seeds.length === 0) return 0
    const now = Date.now()
    const stmt = db.query(
      `INSERT OR IGNORE INTO addressbook
         (id, wallet_id, device_id, kind, network_id, chain_id, address, label,
          derivation_path, script_type, address_index, created_at, updated_at)
       VALUES (?, ?, ?, 'own', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    let inserted = 0
    const tx = db.transaction(() => {
      for (const s of seeds) {
        const addr = normalizeAddress(s.address, s.chainFamily)
        const res = stmt.run(
          crypto.randomUUID(), scope.walletId, scope.deviceId, s.networkId, s.chainId, addr,
          s.label, s.derivationPath ?? null, s.scriptType ?? null, s.addressIndex ?? null, now, now,
        )
        if ((res as any)?.changes) inserted++
      }
    })
    tx()
    return inserted
  } catch (e: any) {
    console.warn('[db] syncOwnAddressBook failed:', e.message)
    return 0
  }
}

/** Record a manual outbound (R3/R7): anchor the recipient entry + append a history
 *  row. Auto-created external rows are left with saved_at=null (history-only) — they
 *  do NOT enter the visible book until the user explicitly saves them (R4 opt-in).
 *  `unsaved` is true when the recipient is not yet a saved contact, driving the
 *  post-send "save this address?" dialog. */
export function recordOutbound(args: {
  walletId: string; deviceId: string
  toAddress: string; networkId: string; chainId: string; chainFamily: string
  fromAddress?: string | null; caip: string; symbol?: string | null; amount?: string | null; txid: string
}): { entryId: string; isNew: boolean; unsaved: boolean } | null {
  try {
    const database = db
    if (!database) return null
    const addr = normalizeAddress(args.toAddress, args.chainFamily)
    const from = args.fromAddress ? normalizeAddress(args.fromAddress, args.chainFamily) : null
    const now = Date.now()
    let entryId = ''
    let isNew = false
    let unsaved = true
    const tx = database.transaction(() => {
      const existing = database.query(
        'SELECT id, saved_at FROM addressbook WHERE wallet_id = ? AND network_id = ? AND address = ?',
      ).get(args.walletId, args.networkId, addr) as { id: string; saved_at: number | null } | null
      if (existing) {
        entryId = existing.id
        unsaved = existing.saved_at == null
        database.run('UPDATE addressbook SET updated_at = ? WHERE id = ?', [now, entryId])
      } else {
        entryId = crypto.randomUUID()
        isNew = true
        database.run(
          `INSERT INTO addressbook
             (id, wallet_id, device_id, kind, network_id, chain_id, address, first_seen_txid, created_at, updated_at)
           VALUES (?, ?, ?, 'external', ?, ?, ?, ?, ?, ?)`,
          [entryId, args.walletId, args.deviceId, args.networkId, args.chainId, addr, args.txid, now, now],
        )
      }
      database.run(
        `INSERT INTO addressbook_tx
           (id, entry_id, wallet_id, device_id, txid, from_address, caip, symbol, amount, broadcast_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), entryId, args.walletId, args.deviceId, args.txid, from, args.caip,
         args.symbol ?? null, args.amount ?? null, now],
      )
    })
    tx()
    return { entryId, isNew, unsaved }
  } catch (e: any) {
    console.warn('[db] recordOutbound failed:', e.message)
    return null
  }
}

/** List entries, optionally filtered by network/chain/kind/search. Own entries are
 *  cross-device (no walletId required, so the book shows every device's wallets);
 *  external entries must be wallet-scoped for privacy. */
export function getAddressBookList(filter: AddressBookFilter): AddressBookEntry[] {
  try {
    if (!db) return []
    // The Address Book is wallet-agnostic: own + external are readable without a
    // wallet scope (omit walletId for a global, cross-wallet listing).
    let sql = 'SELECT * FROM addressbook WHERE 1=1'
    const params: any[] = []
    if (filter.walletId) { sql += ' AND wallet_id = ?'; params.push(filter.walletId) }
    if (filter.networkId) { sql += ' AND network_id = ?'; params.push(filter.networkId) }
    if (filter.chainId)   { sql += ' AND chain_id = ?';   params.push(filter.chainId) }
    if (filter.kind)      { sql += ' AND kind = ?';       params.push(filter.kind) }
    if (filter.savedOnly) { sql += ' AND saved_at IS NOT NULL' }
    if (filter.search) {
      sql += ` AND (label LIKE ? ESCAPE '\\' OR address LIKE ? ESCAPE '\\')`
      const q = `%${filter.search.replace(/[\\%_]/g, c => '\\' + c)}%`
      params.push(q, q)
    }
    sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?'
    params.push(filter.limit ?? 1000, filter.offset ?? 0)
    return (db.query(sql).all(...params) as any[]).map(mapAddressBookRow)
  } catch (e: any) {
    console.warn('[db] getAddressBookList failed:', e.message)
    return []
  }
}

/** Match a recipient against the book for instant form-fill detection (R5). EXACT
 *  networkId equality (never family/prefix — fund safety). Returns the best match:
 *  own wallets first, then explicitly-saved contacts. History-only recipients
 *  (saved_at NULL) do NOT count as "known". null if unknown. */
export function matchAddressBook(networkId: string, address: string, chainFamily: string): AddressBookEntry | null {
  try {
    if (!db) return null
    const addr = normalizeAddress(address, chainFamily)
    const row = db.query(
      `SELECT * FROM addressbook
        WHERE network_id = ? AND address = ? AND (kind = 'own' OR saved_at IS NOT NULL)
        ORDER BY (kind = 'own') DESC, saved_at DESC LIMIT 1`,
    ).get(networkId, addr) as any
    return row ? mapAddressBookRow(row) : null
  } catch (e: any) {
    console.warn('[db] matchAddressBook failed:', e.message)
    return null
  }
}

/** Patch a label/note. Pass walletId to scope by wallet; omit (null) to act on the
 *  entry globally (the book is wallet-agnostic). Returns true if a row changed. */
export function updateAddressBookEntry(
  id: string, walletId: string | null, patch: { label?: string; note?: string },
): boolean {
  try {
    if (!db) return false
    const sets: string[] = []
    const params: any[] = []
    if (patch.label !== undefined) { sets.push('label = ?'); params.push(patch.label || null) }
    if (patch.note !== undefined)  { sets.push('note = ?');  params.push(patch.note || null) }
    if (sets.length === 0) return false
    sets.push('updated_at = ?'); params.push(Date.now())
    let where = 'id = ?'; params.push(id)
    if (walletId) { where += ' AND wallet_id = ?'; params.push(walletId) }
    const res = db.run(`UPDATE addressbook SET ${sets.join(', ')} WHERE ${where}`, params)
    return Boolean((res as any)?.changes)
  } catch (e: any) {
    console.warn('[db] updateAddressBookEntry failed:', e.message)
    return false
  }
}

/** Delete an entry + its history. Pass walletId to scope by wallet; omit (null) for
 *  a global delete (wallet-agnostic book). */
export function deleteAddressBookEntry(id: string, walletId: string | null): void {
  try {
    if (!db) return
    if (walletId) {
      db.run('DELETE FROM addressbook_tx WHERE entry_id = ? AND wallet_id = ?', [id, walletId])
      db.run('DELETE FROM addressbook WHERE id = ? AND wallet_id = ?', [id, walletId])
    } else {
      db.run('DELETE FROM addressbook_tx WHERE entry_id = ?', [id])
      db.run('DELETE FROM addressbook WHERE id = ?', [id])
    }
  } catch (e: any) {
    console.warn('[db] deleteAddressBookEntry failed:', e.message)
  }
}

/** Per-recipient outbound history (R7), newest first. Pass walletId to scope by
 *  wallet; omit (null) for the entry's full history regardless of wallet. */
export function getAddressBookHistory(entryId: string, walletId: string | null, limit = 100): AddressBookTx[] {
  try {
    if (!db) return []
    const sql = walletId
      ? 'SELECT * FROM addressbook_tx WHERE entry_id = ? AND wallet_id = ? ORDER BY broadcast_at DESC LIMIT ?'
      : 'SELECT * FROM addressbook_tx WHERE entry_id = ? ORDER BY broadcast_at DESC LIMIT ?'
    const args = walletId ? [entryId, walletId, limit] : [entryId, limit]
    const rows = db.query(sql).all(...args) as any[]
    return rows.map(mapAddressBookTxRow)
  } catch (e: any) {
    console.warn('[db] getAddressBookHistory failed:', e.message)
    return []
  }
}

/** Manually add (or relabel) an external contact. Upserts on the dedupe key so a
 *  re-add just updates the label. Returns the resulting row. */
export function addExternalEntry(args: {
  walletId: string; deviceId: string; networkId: string; chainId: string; chainFamily: string; address: string; label?: string | null
}): AddressBookEntry | null {
  try {
    if (!db) return null
    const addr = normalizeAddress(args.address, args.chainFamily)
    const now = Date.now()
    const existing = db.query('SELECT id FROM addressbook WHERE wallet_id = ? AND network_id = ? AND address = ?')
      .get(args.walletId, args.networkId, addr) as { id: string } | null
    let id: string
    if (existing) {
      id = existing.id
      // Explicit save — confirm the contact (preserve the original save date if any).
      db.run('UPDATE addressbook SET label = ?, saved_at = COALESCE(saved_at, ?), updated_at = ? WHERE id = ?', [args.label ?? null, now, now, id])
    } else {
      id = crypto.randomUUID()
      db.run(
        `INSERT INTO addressbook
           (id, wallet_id, device_id, kind, network_id, chain_id, address, label, saved_at, created_at, updated_at)
         VALUES (?, ?, ?, 'external', ?, ?, ?, ?, ?, ?, ?)`,
        [id, args.walletId, args.deviceId, args.networkId, args.chainId, addr, args.label ?? null, now, now, now],
      )
    }
    const row = db.query('SELECT * FROM addressbook WHERE id = ?').get(id) as any
    return row ? mapAddressBookRow(row) : null
  } catch (e: any) {
    console.warn('[db] addExternalEntry failed:', e.message)
    return null
  }
}

/** device_id -> label, from device_snapshot (the registered/watch-only device list).
 *  Used to attribute each own address to the device it belongs to. */
export function getDeviceLabelMap(): Record<string, string> {
  try {
    if (!db) return {}
    const rows = db.query('SELECT device_id, label FROM device_snapshot').all() as any[]
    const map: Record<string, string> = {}
    for (const r of rows) if (r.label) map[r.device_id] = r.label
    return map
  } catch (e: any) {
    console.warn('[db] getDeviceLabelMap failed:', e.message)
    return {}
  }
}

/** Per-device cached addresses (the watch-only balance cache) for seeding own
 *  entries across ALL of the user's devices — not just the connected one. One
 *  primary address per chain per device; addresses are already persisted. */
export function getBalancesForOwnSeed(): Array<{ deviceId: string; chainId: string; address: string }> {
  try {
    if (!db) return []
    const rows = db.query(
      "SELECT device_id, chain_id, address FROM balances WHERE address != '' AND device_id != '' AND device_id != 'unknown'",
    ).all() as any[]
    return rows.map(r => ({ deviceId: r.device_id, chainId: r.chain_id, address: r.address }))
  } catch (e: any) {
    console.warn('[db] getBalancesForOwnSeed failed:', e.message)
    return []
  }
}

// ── BIP-85 Seed Metadata ────────────────────────────────────────────

export function getBip85Seeds(fingerprint?: string): Bip85SeedMeta[] {
  try {
    if (!db) { console.warn('[db] getBip85Seeds — db is null'); return [] }
    const sql = fingerprint
      ? 'SELECT wallet_fingerprint, word_count, derivation_index, derivation_path, label, created_at FROM bip85_seeds WHERE wallet_fingerprint = ? ORDER BY created_at DESC'
      : 'SELECT wallet_fingerprint, word_count, derivation_index, derivation_path, label, created_at FROM bip85_seeds ORDER BY created_at DESC'
    const rows = (fingerprint ? db.query(sql).all(fingerprint) : db.query(sql).all()) as Array<{
      wallet_fingerprint: string; word_count: number; derivation_index: number;
      derivation_path: string; label: string; created_at: number
    }>
    console.log('[db] getBip85Seeds — found:', rows.length, 'rows', fingerprint ? `(fp: ${fingerprint.slice(0, 8)}...)` : '(all)')
    return rows.map(r => ({
      walletFingerprint: r.wallet_fingerprint,
      wordCount: r.word_count as 12 | 18 | 24,
      index: r.derivation_index,
      derivationPath: r.derivation_path,
      label: r.label,
      createdAt: r.created_at,
    }))
  } catch (e: any) {
    console.error('[db] getBip85Seeds FAILED:', e.message)
    return []
  }
}

export function saveBip85Seed(meta: Bip85SeedMeta): boolean {
  try {
    if (!db) { console.error('[db] saveBip85Seed — db is null, cannot save'); return false }
    console.log('[db] saveBip85Seed — fp:', meta.walletFingerprint, 'wc:', meta.wordCount, 'idx:', meta.index, 'label:', meta.label)
    db.run(
      `INSERT OR REPLACE INTO bip85_seeds (wallet_fingerprint, word_count, derivation_index, derivation_path, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [meta.walletFingerprint, meta.wordCount, meta.index, meta.derivationPath, meta.label, meta.createdAt]
    )
    // Verify the write
    const check = db.query(
      'SELECT COUNT(*) as count FROM bip85_seeds WHERE wallet_fingerprint = ? AND word_count = ? AND derivation_index = ?'
    ).get(meta.walletFingerprint, meta.wordCount, meta.index) as { count: number } | null
    const verified = (check?.count ?? 0) > 0
    console.log('[db] saveBip85Seed — verified:', verified, 'total in table:', (db.query('SELECT COUNT(*) as c FROM bip85_seeds').get() as any)?.c)
    return verified
  } catch (e: any) {
    console.error('[db] saveBip85Seed FAILED:', e.message, e.stack)
    return false
  }
}


export function deleteBip85Seed(wordCount: number, index: number, fingerprint?: string) {
  try {
    if (!db) return
    if (fingerprint) {
      db.run(
        'DELETE FROM bip85_seeds WHERE wallet_fingerprint = ? AND word_count = ? AND derivation_index = ?',
        [fingerprint, wordCount, index]
      )
    } else {
      db.run(
        'DELETE FROM bip85_seeds WHERE word_count = ? AND derivation_index = ?',
        [wordCount, index]
      )
    }
  } catch (e: any) {
    console.warn('[db] deleteBip85Seed failed:', e.message)
  }
}
