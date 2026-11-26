/** Audit v8 H3/H12: the local API refuses DNS-rebound Hosts, keeps wallet data behind a pairing key,
 *  grants CORS only to extensions and paired origins, and binds each pairing to the request Origin.
 *  Real HTTP routing with an in-memory engine and isolated SQLite. */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const dir = mkdtempSync(join(tmpdir(), 'vault-origin-guard-'))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData: dir } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData: dir } }))
const db = await import('../src/bun/db')
const { AuthStore } = await import('../src/bun/auth')
const { startRestApi } = await import('../src/bun/rest-api')
const nativeFetch = globalThis.fetch

const KEY = 'synthetic-origin-paired', APP = 'https://app.example.invalid'
let stop: (() => void) | undefined
beforeAll(() => {
 db.initDb()
 db.storePairing(KEY, { name: 'QA app', url: APP, imageUrl: '', addedOn: Date.now(), lastUsedOn: Date.now(), origin: APP })
})
afterEach(() => { stop?.(); stop = undefined })
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

function vault(onPairRequest: (info: any) => void = () => {}) {
 const engine: any = Object.assign(new EventEmitter(), { wallet: {}, isEmulator: false, isPassphraseWallet: false, isSyncing: false,
  getDeviceState: () => ({ state: 'ready', deviceId: 'synthetic-origin', firmwareVersion: '7.17.0', capabilities: [] }) })
 Object.defineProperty(engine, 'isLocked', { get: () => false })
 const auth = new AuthStore()
 const server = startRestApi(engine, auth, 0, { onApiLog: () => {}, onPairRequest, getVersion: () => '1.7.1' } as any, '127.0.0.1')
 stop = () => server.stop(true)
 const request = async (route: string, headers: Record<string, string> = {}, init: RequestInit = {}) => {
  const response = await nativeFetch(`http://127.0.0.1:${server.port}${route}`, { ...init, headers })
  return { status: response.status, cors: response.headers.get('access-control-allow-origin'), data: await response.json().catch(() => null) as any }
 }
 return { auth, request }
}

describe('H3: DNS rebinding, auth on wallet data, CORS allowlist', () => {
 test('a request whose Host is not loopback is refused', async () => {
  const { request } = vault()
  for (const host of ['evil.example:1646', 'evil.example', 'localhost.evil.example']) expect((await request('/api/portfolio', { Host: host, Authorization: `Bearer ${KEY}` })).status).toBe(403)
  expect((await request('/api/health', { Host: 'localhost:1646' })).status).toBe(200)
 })

 test('wallet and pairing data need a pairing key', async () => {
  const { request } = vault()
  for (const route of ['/api/portfolio', '/auth/paired-apps', '/admin/info', '/api/cache/status']) {
   expect((await request(route)).status).toBe(401)
   expect((await request(route, { Authorization: `Bearer ${KEY}` })).status).toBe(200)
  }
 })

 test('CORS goes to the paired origin and extensions, never to any other website', async () => {
  const { request } = vault()
  const auth = { Authorization: `Bearer ${KEY}` }
  expect((await request('/api/portfolio', { ...auth, Origin: APP })).cors).toBe(APP)
  expect((await request('/api/portfolio', { ...auth, Origin: 'chrome-extension://abcdefghijklmnop' })).cors).toBe('chrome-extension://abcdefghijklmnop')
  expect((await request('/api/portfolio', { ...auth, Origin: 'https://evil.example' })).cors).toBeNull()
  expect((await request('/api/portfolio', { ...auth })).cors).toBeNull()
  // Preflight: a website may reach the pairing entry, not the wallet routes.
  expect((await request('/auth/pair', { Origin: 'https://evil.example' }, { method: 'OPTIONS' })).cors).toBe('https://evil.example')
  expect((await request('/api/portfolio', { Origin: 'https://evil.example' }, { method: 'OPTIONS' })).cors).toBeNull()
 })
})

describe('H12: pairing is bound to the request Origin', () => {
 const pair = (request: any, origin?: string) => request('/auth/pair', { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
  { method: 'POST', body: JSON.stringify({ name: 'KeepKey Browser Extension', url: 'https://keepkey.com', imageUrl: '', origin: 'chrome-extension://forged' }) })

 test('the prompt and the stored pairing carry the Origin header, not a body field', async () => {
  const prompts: any[] = []
  const { auth, request } = vault(info => prompts.push(info))
  const pending = pair(request, 'https://evil.example')
  while (!auth.getPendingPair()) await Bun.sleep(5)
  expect(prompts[0]).toMatchObject({ name: 'KeepKey Browser Extension', origin: 'https://evil.example' })
  auth.approvePairing()
  const { data } = await pending
  expect(data.reused).toBe(false)
  expect(auth.validate(data.apiKey)?.info.origin).toBe('https://evil.example')
  expect(db.getStoredPairings().find(row => row.apiKey === data.apiKey)?.origin).toBe('https://evil.example')
 })

 test('the same name from a different origin does not get the existing key', async () => {
  const { auth, request } = vault()
  const first = pair(request, 'chrome-extension://abcdefghijklmnop')
  while (!auth.getPendingPair()) await Bun.sleep(5)
  auth.approvePairing()
  const ext = (await first).data
  const second = pair(request, 'https://evil.example')
  while (!auth.getPendingPair()) await Bun.sleep(5)
  auth.approvePairing()
  const site = (await second).data
  expect(site.apiKey).not.toBe(ext.apiKey)
  const third = pair(request, 'chrome-extension://abcdefghijklmnop')
  while (!auth.getPendingPair()) await Bun.sleep(5)
  auth.approvePairing()
  expect((await third).data).toEqual({ apiKey: ext.apiKey, reused: true })
 })

 test('a page cannot flood the user with pairing prompts', async () => {
  const { auth, request } = vault()
  for (let i = 0; i < 3; i++) {
   const p = pair(request, 'https://flood.example')
   while (!auth.getPendingPair()) await Bun.sleep(5)
   auth.rejectPairing()
   await p
  }
  expect((await pair(request, 'https://flood.example')).status).toBe(429)
 })
})
