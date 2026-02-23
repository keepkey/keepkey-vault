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
import type { ChainBalance, CustomToken, CustomChain, PairedAppInfo, ApiLogEntry } from '../shared/types'

const SCHEMA_VERSION = '6'

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
        chain_id     INTEGER PRIMARY KEY,
        name         TEXT NOT NULL,
        symbol       TEXT NOT NULL,
        rpc_url      TEXT NOT NULL,
        explorer_url TEXT
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

export function getCachedBalances(deviceId: string): ChainBalance[] | null {
  try {
    if (!db) return null
    const rows = db.query(
      'SELECT chain_id, symbol, balance, balance_usd, address FROM balances WHERE device_id = ?'
    ).all(deviceId) as Array<{ chain_id: string; symbol: string; balance: string; balance_usd: number; address: string }>
    if (!rows || rows.length === 0) return null
    return rows.map(r => ({
      chainId: r.chain_id,
      symbol: r.symbol,
      balance: r.balance,
      balanceUsd: r.balance_usd,
      address: r.address,
    }))
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
      `INSERT OR REPLACE INTO balances (device_id, chain_id, symbol, balance, balance_usd, address, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const tx = db.transaction(() => {
      for (const b of balances) {
        stmt.run(deviceId, b.chainId, b.symbol, b.balance, b.balanceUsd, b.address, now)
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

// ── Pioneer Cache (TTL-based JSON blobs) ──────────────────────────────

export function getPioneerCache(key: string, maxAgeMs: number): any | null {
  try {
    if (!db) return null
    const row = db.query(
      'SELECT data, updated_at FROM pioneer_cache WHERE cache_key = ?'
    ).get(key) as { data: string; updated_at: number } | null
    if (!row) return null
    if (Date.now() - row.updated_at > maxAgeMs) return null
    return JSON.parse(row.data)
  } catch (e: any) {
    console.warn('[db] getPioneerCache failed:', e.message)
    return null
  }
}

export function setPioneerCache(key: string, data: any) {
  try {
    if (!db) return
    db.run(
      `INSERT OR REPLACE INTO pioneer_cache (cache_key, data, updated_at) VALUES (?, ?, ?)`,
      [key, JSON.stringify(data), Date.now()]
    )
  } catch (e: any) {
    console.warn('[db] setPioneerCache failed:', e.message)
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
    const rows = db.query('SELECT chain_id, name, symbol, rpc_url, explorer_url FROM custom_chains').all() as Array<{
      chain_id: number; name: string; symbol: string; rpc_url: string; explorer_url: string | null
    }>
    return rows.map(r => ({ chainId: r.chain_id, name: r.name, symbol: r.symbol, rpcUrl: r.rpc_url, explorerUrl: r.explorer_url || undefined }))
  } catch (e: any) {
    console.warn('[db] getCustomChains failed:', e.message)
    return []
  }
}

export function addCustomChainDb(chain: CustomChain) {
  try {
    if (!db) return
    db.run(
      `INSERT OR REPLACE INTO custom_chains (chain_id, name, symbol, rpc_url, explorer_url) VALUES (?, ?, ?, ?, ?)`,
      [chain.chainId, chain.name, chain.symbol, chain.rpcUrl, chain.explorerUrl || null]
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

export function hasWatchOnlyData(): boolean {
  try {
    if (!db) return false
    const row = db.query('SELECT COUNT(*) as cnt FROM device_snapshot').get() as { cnt: number } | null
    return (row?.cnt ?? 0) > 0
  } catch (e: any) {
    console.warn('[db] hasWatchOnlyData failed:', e.message)
    return false
  }
}
