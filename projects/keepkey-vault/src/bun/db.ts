/**
 * SQLite balance cache using bun:sqlite (built-in, zero deps).
 *
 * All functions are defensive — if the DB is null or throws, they return
 * null / no-op and log a warning. The app never crashes from cache failure.
 */
import { Database } from 'bun:sqlite'
import { Utils } from 'electrobun/bun'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { ChainBalance, CustomToken, CustomChain, PairedAppInfo, ApiLogEntry, ReportMeta, ReportData, SwapHistoryRecord, SwapHistoryFilter, SwapTrackingStatus, SwapHistoryStats, Bip85SeedMeta } from '../shared/types'

const SCHEMA_VERSION = '8'

let db: Database | null = null

// ── Lifecycle ──────────────────────────────────────────────────────────

export function initDb() {
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
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (device_id, chain_id)
      )
    `)

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
        PRIMARY KEY (chain_id, contract_address)
      )
    `)

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
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (device_id, chain_id, path)
      )
    `)


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
        txid                TEXT NOT NULL,
        from_asset          TEXT NOT NULL,
        to_asset            TEXT NOT NULL,
        from_symbol         TEXT NOT NULL,
        to_symbol           TEXT NOT NULL,
        from_chain_id       TEXT NOT NULL,
        to_chain_id         TEXT NOT NULL,
        from_amount         TEXT NOT NULL,
        quoted_output       TEXT NOT NULL,
        minimum_output      TEXT NOT NULL DEFAULT '0',
        received_output     TEXT,
        slippage_bps        INTEGER NOT NULL DEFAULT 300,
        fee_bps             INTEGER NOT NULL DEFAULT 0,
        fee_outbound        TEXT NOT NULL DEFAULT '0',
        integration         TEXT NOT NULL DEFAULT 'thorchain',
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

    // Migrations: add columns to existing tables (safe to re-run)
    for (const col of ['explorer_address_link TEXT', 'explorer_tx_link TEXT']) {
      try { db.exec(`ALTER TABLE custom_chains ADD COLUMN ${col}`) } catch { /* already exists */ }
    }

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

// ── Balance Cache ──────────────────────────────────────────────────────

export function getCachedBalances(deviceId: string): { balances: ChainBalance[]; updatedAt: number } | null {
  try {
    if (!db) return null
    const rows = db.query(
      'SELECT chain_id, symbol, balance, balance_usd, address, tokens_json, updated_at FROM balances WHERE device_id = ?'
    ).all(deviceId) as Array<{ chain_id: string; symbol: string; balance: string; balance_usd: number; address: string; tokens_json: string | null; updated_at: number }>
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
      }
      if (r.tokens_json) {
        try { entry.tokens = JSON.parse(r.tokens_json) } catch { /* corrupt JSON, skip tokens */ }
      }
      return entry
    })
    return { balances, updatedAt: maxUpdatedAt }
  } catch (e: any) {
    console.warn('[db] getCachedBalances failed:', e.message)
    return null
  }
}

export function setCachedBalances(deviceId: string, balances: ChainBalance[]) {
  try {
    if (!db) return
    const now = Date.now()
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO balances (device_id, chain_id, symbol, balance, balance_usd, address, tokens_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const tx = db.transaction(() => {
      for (const b of balances) {
        const tokensJson = b.tokens && b.tokens.length > 0 ? JSON.stringify(b.tokens) : null
        stmt.run(deviceId, b.chainId, b.symbol, b.balance, b.balanceUsd, b.address, tokensJson, now)
      }
    })
    tx()
  } catch (e: any) {
    console.warn('[db] setCachedBalances failed:', e.message)
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

// ── Custom Tokens ────────────────────────────────────────────────────

export function getCustomTokens(): CustomToken[] {
  try {
    if (!db) return []
    const rows = db.query('SELECT chain_id, contract_address, symbol, name, decimals, network_id FROM custom_tokens').all() as Array<{
      chain_id: string; contract_address: string; symbol: string; name: string; decimals: number; network_id: string
    }>
    return rows.map(r => ({ chainId: r.chain_id, contractAddress: r.contract_address, symbol: r.symbol, name: r.name, decimals: r.decimals, networkId: r.network_id }))
  } catch (e: any) {
    console.warn('[db] getCustomTokens failed:', e.message)
    return []
  }
}

export function addCustomToken(token: CustomToken) {
  try {
    if (!db) return
    db.run(
      `INSERT OR REPLACE INTO custom_tokens (chain_id, contract_address, symbol, name, decimals, network_id) VALUES (?, ?, ?, ?, ?, ?)`,
      [token.chainId, token.contractAddress, token.symbol, token.name, token.decimals, token.networkId]
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
    const rows = db.query('SELECT api_key, name, url, image_url, added_on FROM paired_apps').all() as Array<{
      api_key: string; name: string; url: string; image_url: string; added_on: number
    }>
    return rows.map(r => ({ apiKey: r.api_key, name: r.name, url: r.url, imageUrl: r.image_url, addedOn: r.added_on }))
  } catch (e: any) {
    console.warn('[db] getStoredPairings failed:', e.message)
    return []
  }
}

export function storePairing(apiKey: string, info: { name: string; url: string; imageUrl: string; addedOn: number }) {
  try {
    if (!db) return
    db.run(
      'INSERT OR REPLACE INTO paired_apps (api_key, name, url, image_url, added_on) VALUES (?, ?, ?, ?, ?)',
      [apiKey, info.name, info.url || '', info.imageUrl || '', info.addedOn]
    )
  } catch (e: any) {
    console.warn('[db] storePairing failed:', e.message)
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

// ── API Audit Log ──────────────────────────────────────────────────────

const MAX_API_LOG_ROWS = 5000

/** Insert an API log entry and prune old rows beyond MAX_API_LOG_ROWS */
export function insertApiLog(entry: ApiLogEntry) {
  try {
    if (!db) return
    db.run(
      `INSERT INTO api_log (method, route, timestamp, duration_ms, status, app_name, image_url, request_body, response_body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.method,
        entry.route,
        entry.timestamp,
        entry.durationMs,
        entry.status,
        entry.appName,
        entry.imageUrl || null,
        entry.requestBody ? JSON.stringify(entry.requestBody) : null,
        entry.responseBody ? JSON.stringify(entry.responseBody) : null,
      ]
    )
    // Periodic prune (every ~100 inserts, check if over limit)
    if (Math.random() < 0.01) {
      db.run(`DELETE FROM api_log WHERE id NOT IN (SELECT id FROM api_log ORDER BY timestamp DESC LIMIT ?)`, [MAX_API_LOG_ROWS])
    }
  } catch (e: any) {
    console.warn('[db] insertApiLog failed:', e.message)
  }
}

/** Get recent API log entries (newest first) */
export function getApiLogs(limit = 200, offset = 0): ApiLogEntry[] {
  try {
    if (!db) return []
    const rows = db.query(
      'SELECT id, method, route, timestamp, duration_ms, status, app_name, image_url, request_body, response_body FROM api_log ORDER BY timestamp DESC LIMIT ? OFFSET ?'
    ).all(limit, offset) as Array<{
      id: number; method: string; route: string; timestamp: number; duration_ms: number;
      status: number; app_name: string; image_url: string | null;
      request_body: string | null; response_body: string | null
    }>
    return rows.map(r => ({
      id: r.id,
      method: r.method,
      route: r.route,
      timestamp: r.timestamp,
      durationMs: r.duration_ms,
      status: r.status,
      appName: r.app_name,
      imageUrl: r.image_url || undefined,
      requestBody: r.request_body ? JSON.parse(r.request_body) : undefined,
      responseBody: r.response_body ? JSON.parse(r.response_body) : undefined,
    }))
  } catch (e: any) {
    console.warn('[db] getApiLogs failed:', e.message)
    return []
  }
}

/** Clear all API logs */
export function clearApiLogs() {
  try {
    if (!db) return
    db.run('DELETE FROM api_log')
  } catch (e: any) {
    console.warn('[db] clearApiLogs failed:', e.message)
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

// ── Cached Pubkeys (watch-only address cache) ───────────────────────

export function saveCachedPubkey(deviceId: string, chainId: string, path: string, xpub: string, address: string, scriptType: string) {
  try {
    if (!db) return
    db.run(
      `INSERT OR REPLACE INTO cached_pubkeys (device_id, chain_id, path, xpub, address, script_type, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [deviceId, chainId, path || '', xpub || '', address || '', scriptType || '', Date.now()]
    )
  } catch (e: any) {
    console.warn('[db] saveCachedPubkey failed:', e.message)
  }
}

export function getCachedPubkeys(deviceId: string): Array<{ chainId: string; path: string; xpub: string; address: string; scriptType: string }> {
  try {
    if (!db) return []
    const rows = db.query(
      'SELECT chain_id, path, xpub, address, script_type FROM cached_pubkeys WHERE device_id = ?'
    ).all(deviceId) as Array<{ chain_id: string; path: string; xpub: string; address: string; script_type: string }>
    return rows.map(r => ({ chainId: r.chain_id, path: r.path, xpub: r.xpub, address: r.address, scriptType: r.script_type }))
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
        (id, txid, from_asset, to_asset, from_symbol, to_symbol, from_chain_id, to_chain_id,
         from_amount, quoted_output, minimum_output, received_output, slippage_bps, fee_bps,
         fee_outbound, integration, memo, inbound_address, router, status, outbound_txid,
         error, created_at, updated_at, completed_at, estimated_time_secs, actual_time_secs, approval_txid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id, record.txid, record.fromAsset, record.toAsset,
        record.fromSymbol, record.toSymbol, record.fromChainId, record.toChainId,
        record.fromAmount, record.quotedOutput, record.minimumOutput,
        record.receivedOutput || null,
        record.slippageBps, record.feeBps, record.feeOutbound,
        record.integration, record.memo, record.inboundAddress,
        record.router || null, record.status, record.outboundTxid || null,
        record.error || null, record.createdAt, record.updatedAt,
        record.completedAt || null, record.estimatedTimeSeconds,
        record.actualTimeSeconds || null, record.approvalTxid || null,
      ]
    )
  } catch (e: any) {
    console.warn('[db] insertSwapHistory failed:', e.message)
  }
}

/** Update swap status and related fields (called on every status change) */
export function updateSwapHistoryStatus(
  txid: string,
  status: SwapTrackingStatus,
  extra?: {
    outboundTxid?: string
    error?: string
    receivedOutput?: string
    completedAt?: number
    actualTimeSeconds?: number
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

    if (extra?.outboundTxid) setClauses.push({ col: 'outbound_txid', value: extra.outboundTxid })
    if (extra?.error) setClauses.push({ col: 'error', value: extra.error })
    if (extra?.receivedOutput) setClauses.push({ col: 'received_output', value: extra.receivedOutput })
    if (isFinal) {
      setClauses.push({ col: 'completed_at', value: extra?.completedAt || now })
      if (extra?.actualTimeSeconds !== undefined) {
        setClauses.push({ col: 'actual_time_secs', value: extra.actualTimeSeconds })
      }
    }

    const sql = `UPDATE swap_history SET ${setClauses.map(c => `${c.col} = ?`).join(', ')} WHERE txid = ?`
    const params = [...setClauses.map(c => c.value), txid]

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
    if (filter?.fromDate) {
      sql += ` AND created_at >= ?`
      params.push(filter.fromDate)
    }
    if (filter?.toDate) {
      sql += ` AND created_at <= ?`
      params.push(filter.toDate)
    }
    if (filter?.asset) {
      sql += ` AND (from_symbol LIKE ? OR to_symbol LIKE ? OR from_asset LIKE ? OR to_asset LIKE ?)`
      const q = `%${filter.asset}%`
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
export function getSwapHistoryByTxid(txid: string): SwapHistoryRecord | null {
  try {
    if (!db) return null
    const row = db.query('SELECT * FROM swap_history WHERE txid = ?').get(txid) as any
    return row ? mapSwapRow(row) : null
  } catch (e: any) {
    console.warn('[db] getSwapHistoryByTxid failed:', e.message)
    return null
  }
}

/** Get aggregate stats for swap history */
export function getSwapHistoryStats(): SwapHistoryStats {
  try {
    if (!db) return { totalSwaps: 0, completed: 0, failed: 0, refunded: 0, pending: 0 }
    const row = db.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) as refunded,
        SUM(CASE WHEN status NOT IN ('completed', 'failed', 'refunded') THEN 1 ELSE 0 END) as pending
      FROM swap_history
    `).get() as any
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
    txid: r.txid,
    fromAsset: r.from_asset,
    toAsset: r.to_asset,
    fromSymbol: r.from_symbol,
    toSymbol: r.to_symbol,
    fromChainId: r.from_chain_id,
    toChainId: r.to_chain_id,
    fromAmount: r.from_amount,
    quotedOutput: r.quoted_output,
    minimumOutput: r.minimum_output,
    receivedOutput: r.received_output || undefined,
    slippageBps: r.slippage_bps,
    feeBps: r.fee_bps,
    feeOutbound: r.fee_outbound,
    integration: r.integration,
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
  }
}

// ── BIP-85 Seed Metadata ────────────────────────────────────────────

export function getBip85Seeds(): Bip85SeedMeta[] {
  try {
    if (!db) { console.warn('[db] getBip85Seeds — db is null'); return [] }
    const rows = db.query(
      'SELECT wallet_fingerprint, word_count, derivation_index, derivation_path, label, created_at FROM bip85_seeds ORDER BY created_at DESC'
    ).all() as Array<{
      wallet_fingerprint: string; word_count: number; derivation_index: number;
      derivation_path: string; label: string; created_at: number
    }>
    console.log('[db] getBip85Seeds — found:', rows.length, 'rows')
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


export function deleteBip85Seed(wordCount: number, index: number) {
  try {
    if (!db) return
    db.run(
      'DELETE FROM bip85_seeds WHERE word_count = ? AND derivation_index = ?',
      [wordCount, index]
    )
  } catch (e: any) {
    console.warn('[db] deleteBip85Seed failed:', e.message)
  }
}

