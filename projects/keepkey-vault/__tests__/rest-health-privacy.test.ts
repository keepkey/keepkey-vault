/** Audit v6 N5: /api/health is readable by any website (CORS '*'). Its documented public fields stay public;
 *  the sync diagnostics go only to a paired key or a local non-browser tool (curl), never to a website.
 *  Real HTTP routing with an in-memory engine and isolated SQLite. */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const dir = mkdtempSync(join(tmpdir(), 'vault-health-privacy-'))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData: dir } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData: dir } }))
const db = await import('../src/bun/db')
const { AuthStore } = await import('../src/bun/auth')
const { startRestApi } = await import('../src/bun/rest-api')
const nativeFetch = globalThis.fetch

const PAIRED = 'synthetic-health-paired', EXPIRED = 'synthetic-health-expired'
// What a website must never read: which chains sync, timings, failures and connectivity probes.
const DIAGNOSTICS = {
 balanceSync: { id: 'sync-1', status: 'running', stage: 'balances', tasks: [{ label: 'bitcoin', elapsedMs: 12 }] },
 recentSyncs: [], connectivity: [{ online: true, durationMs: 40, checkedAt: 1, status: 200 }],
}
// The fields docs/API.md promises every caller. Adding one is a product decision, so this list is exact.
const PUBLIC_FIELDS = ['apiVersion', 'cached_pubkeys', 'connected', 'device_connected', 'device_locked', 'frontload_progress',
 'ready', 'status', 'supportedChains', 'syncing', 'uptime', 'version']

let stop: (() => void) | undefined
beforeAll(() => {
 db.initDb()
 db.storePairing(PAIRED, { name: 'QA app', url: 'https://app.example.invalid', imageUrl: '', addedOn: Date.now(), lastUsedOn: Date.now() })
 const old = Date.now() - 31 * 24 * 60 * 60 * 1000
 db.storePairing(EXPIRED, { name: 'Stale app', url: 'https://stale.example.invalid', imageUrl: '', addedOn: old, lastUsedOn: old })
})
afterEach(() => { stop?.(); stop = undefined })
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

function vault() {
 const engine: any = Object.assign(new EventEmitter(), { wallet: {}, isEmulator: false, isPassphraseWallet: false, isSyncing: false,
  getDeviceState: () => ({ state: 'ready', deviceId: 'synthetic-health', firmwareVersion: '7.17.0', capabilities: [] }) })
 Object.defineProperty(engine, 'isLocked', { get: () => false })
 const server = startRestApi(engine, new AuthStore(), 0, { onApiLog: () => {}, getVersion: () => '1.7.1', getSyncDiagnostics: () => structuredClone(DIAGNOSTICS) } as any, '127.0.0.1')
 stop = () => server.stop(true)
 return async (route: string, headers: Record<string, string> = {}) => {
  const response = await nativeFetch(`http://127.0.0.1:${server.port}${route}`, { headers })
  return { status: response.status, cors: response.headers.get('access-control-allow-origin'), cache: response.headers.get('cache-control'), vary: response.headers.get('vary'),
   data: await response.json() as Record<string, unknown> }
 }
}

// What a browser attaches to a fetch (page scripts cannot remove either header).
const WEBSITE = { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' }

describe('N5: /api/health shows sync diagnostics only to a paired key or a local tool, not to a website', () => {
 for (const route of ['/api/health', '/api/v1/health']) {
  test(`${route}: a website gets the documented public fields and nothing more`, async () => {
   const health = await vault()(route, WEBSITE)
   expect(health.status).toBe(200)
   expect(health.cors).toBe('https://evil.example')
   expect(Object.keys(health.data).sort()).toEqual(PUBLIC_FIELDS)
   expect(health.data).toMatchObject({ status: 'healthy', apiVersion: 2, ready: true, connected: true, device_connected: true, device_locked: false, version: '1.7.1' })
   expect(health.data.supportedChains).toContain('eip155:1')
   expect(new Set(health.data.supportedChains).size).toBe(health.data.supportedChains.length)
  })

  test(`${route}: a paired app gets the sync diagnostics, even from a browser`, async () => {
   const health = await vault()(route, { ...WEBSITE, Authorization: `Bearer ${PAIRED}` })
   expect(health.status).toBe(200)
   expect(Object.keys(health.data).sort()).toEqual([...PUBLIC_FIELDS, 'sync_diagnostics'].sort())
   expect(health.data.sync_diagnostics).toEqual(DIAGNOSTICS)
  })

  test(`${route}: a local tool such as curl (no browser headers) keeps getting them without a key`, async () => {
   const health = await vault()(route)
   expect(health.status).toBe(200)
   expect(health.data.sync_diagnostics).toEqual(DIAGNOSTICS)
  })
 }

 test('either browser header alone marks a browser: a same-origin page of the Vault itself gets no diagnostics', async () => {
  const request = vault()
  for (const headers of [{ 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Site': 'none' }, { Origin: 'http://localhost:1646' }, { Origin: 'null' }]) {
   const health = await request('/api/health', headers)
   expect(health.status).toBe(200)
   expect(Object.keys(health.data).sort()).toEqual(PUBLIC_FIELDS)
  }
 })

 test('from a browser, an unknown, expired or malformed key is treated as public, never as an error', async () => {
  const request = vault()
  for (const authorization of [`Bearer ${EXPIRED}`, 'Bearer not-a-paired-key', `Basic ${PAIRED}`, 'Bearer']) {
   const health = await request('/api/health', { ...WEBSITE, Authorization: authorization })
   expect(health.status).toBe(200)
   expect(Object.keys(health.data).sort()).toEqual(PUBLIC_FIELDS)
  }
 })

 test('a DNS-rebound website (same-origin, so no Origin or Sec-Fetch-Site, but its own Host) is refused', async () => {
  const request = vault()
  for (const host of ['rebind.attacker.example:1646', 'rebind.attacker.example', '127.0.0.1.attacker.example:1646', 'localhost.attacker.example', '127.0.0.1.nip.example:1646']) {
   const health = await request('/api/health', { Host: host })
   expect(health.status).toBe(403)
   expect(health.data).not.toHaveProperty('sync_diagnostics')
  }
  // curl names the loopback however the team types it.
  for (const host of ['127.0.0.1:1646', 'localhost:1646', 'LOCALHOST', '[::1]:1646']) expect((await request('/api/health', { Host: host })).data.sync_diagnostics).toEqual(DIAGNOSTICS)
 })

 test('the answer depends on the caller, so it is never cached', async () => {
  const health = await vault()('/api/health', WEBSITE)
  expect(health.cache).toBe('no-store')
  for (const header of ['Authorization', 'Host', 'Origin', 'Sec-Fetch-Site']) expect(health.vary).toContain(header)
 })

 test('"syncing" still reflects a running balance sync for a website', async () => {
  const health = await vault()('/api/health', WEBSITE)
  expect(health.data.syncing).toBe(true)
  expect(health.data).not.toHaveProperty('sync_diagnostics')
 })
})
