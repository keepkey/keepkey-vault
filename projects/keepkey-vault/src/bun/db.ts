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
import type { ChainBalance, CustomToken, CustomChain } from '../shared/types'

const SCHEMA_VERSION = '2'

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
      db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')`)
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
