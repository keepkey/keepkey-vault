/** Real HTTP routing with an in-memory wallet and isolated SQLite profile. */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const dir = mkdtempSync(join(tmpdir(), 'vault-demand-unlock-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('../src/bun/db')
const { AuthStore } = await import('../src/bun/auth')
const { startRestApi } = await import('../src/bun/rest-api')
const { DeviceOperationCoordinator } = await import('../src/bun/device-operation')
const nativeFetch = globalThis.fetch
const sleep = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean) { const end = Date.now() + 2000; while (!check() && Date.now() < end) await sleep(); expect(check()).toBe(true) }
const address = '0x000000000000000000000000000000000000dEaD'
const path = [0x8000002c, 0x8000003c, 0x80000000, 0, 0]
let stop: (() => void) | undefined
beforeAll(() => { db.initDb(); db.storePairing('synthetic-demand', { name: 'QA BEX', url: 'https://bex.example.invalid', imageUrl: '', addedOn: Date.now(), lastUsedOn: Date.now() }) })
afterEach(() => { stop?.(); stop = undefined })
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })
function fixture(initiallyLocked = true) {
 const state = { locked: initiallyLocked, phase: undefined as string | undefined, epoch: 0, unlocks: 0, reads: 0, leases: 0, releases: 0, approvals: 0, signs: 0, focus: 0, waitApproval: false, setupCalls: [] as string[], recoveryOwner: undefined as string | undefined }
 let resolveUnlock: () => void = () => { throw new Error('Unlock was not requested') }
 const phase = () => state.phase ?? (state.locked ? 'needs_pin' : 'ready')
 const features = () => ({ vendor: 'keepkey.com', majorVersion: 7, minorVersion: 17, patchVersion: 0, deviceId: 'synthetic-demand', initialized: phase() !== 'needs_init', pinProtection: true, pinCached: !state.locked, policiesList: [] })
 const wallet = { getFeatures: async () => features(), ethGetAddress: async () => { state.reads++; return address }, ethSignMessage: async () => { state.signs++; throw new Error('Real signing forbidden') }, reset: async () => { state.setupCalls.push('reset') }, recover: async () => { state.setupCalls.push('recover'); expect(state.recoveryOwner).toBe('synthetic-demand') }, loadDevice: async () => { state.setupCalls.push('load') } }
 const engine: any = Object.assign(new EventEmitter(), { wallet, isEmulator: false, isPassphraseWallet: false, isSyncing: false, wipeInProgress: false, wipeOnReconnect: false, currentSeedEthAddress: address,
  getDeviceState: () => ({ state: phase(), deviceId: 'synthetic-demand', firmwareVersion: '7.17.0', capabilities: [] }), getCachedFeaturesSnapshot: features,
  beginRecovery: (owner: string) => { state.recoveryOwner = owner }, endRecovery: () => { state.recoveryOwner = undefined } })
 Object.defineProperty(engine, 'isLocked', { get: () => state.locked })
 const coordinator = new DeviceOperationCoordinator({ snapshot: () => ({ wallet: engine.wallet, deviceId: 'synthetic-demand', seedAddress: address, state: phase() as any }), unlock: signal => {
  state.unlocks++
  return new Promise<void>((resolve, reject) => {
   const abort = () => reject(Object.assign(new Error('Cancelled'), { status: 499 }))
   signal.addEventListener('abort', abort, { once: true })
   resolveUnlock = () => { signal.removeEventListener('abort', abort); state.locked = false; resolve() }
   if (signal.aborted) abort()
  })
 } })
 engine.acquireDeviceOperation = async (options: any) => { const release = await coordinator.acquire(options); state.leases++; return () => { state.releases++; release() } }
 const server = startRestApi(engine, new AuthStore(), 0, { onApiLog: () => {}, onPairRequest: () => {}, getVersion: () => 'synthetic', getSessionEpoch: () => state.epoch,
  onDeviceRequest: () => { state.focus++; return () => { state.focus-- } },
  onSigningRequest: async (_info: unknown, signal?: AbortSignal) => { state.approvals++; if (state.waitApproval) return new Promise(resolve => { const done = () => resolve({ approved: false }); signal?.addEventListener('abort', done, { once: true }); if (signal?.aborted) done() }); return { approved: false } }, onSigningDismissed: () => {},
 } as any, '127.0.0.1')
 stop = () => server.stop(true)
 async function request(route: string, body?: any, access?: string, signal?: AbortSignal) {
  const response = await nativeFetch(`http://127.0.0.1:${server.port}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer synthetic-demand', 'Content-Type': 'application/json', ...(access ? { 'X-KeepKey-Device-Access': access } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal })
  return { status: response.status, data: await response.json() as any }
 }
 return { state, engine, request, unlock: () => resolveUnlock() }
}
describe('API availability is separate from device access', () => {
 test.each(['reset', 'recover', 'load'])('uninitialized device can enter %s without a wallet unlock', async action => {
  const f = fixture(false); f.state.phase = 'needs_init'
  expect((await f.request(`/system/initialize/${action}-device`, {})).status).toBe(200)
  expect(f.state.setupCalls).toEqual([action]); expect(f.state.unlocks).toBe(0); expect(f.state.leases).toBe(0)
  expect(f.state.recoveryOwner).toBeUndefined()
 })
 test.each(['reset', 'recover', 'load'])('initialized locked device retains the unlock gate for %s', async action => {
  const f = fixture()
  const pending = f.request(`/system/initialize/${action}-device`, {})
  await until(() => f.state.unlocks === 1); expect(f.state.setupCalls).toEqual([])
  f.unlock(); expect((await pending).status).toBe(200)
  expect(f.state.setupCalls).toEqual([action]); expect(f.state.leases).toBe(1); expect(f.state.releases).toBe(1)
 })
 test.each(['wipeInProgress', 'wipeOnReconnect'])('uninitialized setup keeps the %s guard', async guard => {
  const f = fixture(false); f.state.phase = 'needs_init'; f.engine[guard] = true
  expect((await f.request('/system/initialize/load-device', {})).status).toBe(409)
  expect(f.state.setupCalls).toEqual([])
 })
 test('locked health, pairing and metadata do not unlock', async () => {
  const f = fixture()
  const health = await f.request('/api/health'); expect(health.status).toBe(200); expect(health.data.device_locked).toBe(true); expect(health.data.connected).toBe(true)
  expect((await f.request('/auth/pair')).data.paired).toBe(true)
  expect((await f.request('/system/info/get-features', {})).status).toBe(200)
  expect(f.state.unlocks).toBe(0); expect(f.state.reads).toBe(0)
 })
 test('a warm same-wallet address is served locked without acquiring the device', async () => {
  const f = fixture(false)
  expect((await f.request('/addresses/eth', { address_n: path }, 'foreground')).status).toBe(200)
  f.state.locked = true; f.engine.emit('state-change', f.engine.getDeviceState())
  expect((await f.request('/addresses/eth', { address_n: path }, 'cached')).data.address).toBe(address)
  expect(f.state.reads).toBe(1); expect(f.state.leases).toBe(1); expect(f.state.releases).toBe(1); expect(f.state.unlocks).toBe(0); expect(f.state.focus).toBe(0)
 })
 test.each([true, false])('cache-only misses never touch the device (locked=%s)', async locked => {
  const f = fixture(locked)
  expect((await f.request('/addresses/eth', { address_n: path }, 'cached')).status).toBe(423)
  expect((await f.request('/api/pubkeys/batch', { paths: [{ address_n: path, type: 'address', networks: ['eip155:1'] }] }, 'cached')).status).toBe(423)
  expect(f.state.unlocks).toBe(0); expect(f.state.reads).toBe(0); expect(f.state.leases).toBe(0)
 })
 test('a complete warmed pubkey batch stays available while locked', async () => {
  const f = fixture(false)
  const body = { paths: [{ address_n: path, type: 'address', networks: ['eip155:1'] }] }
  expect((await f.request('/api/pubkeys/batch', body, 'foreground')).data.pubkeys).toHaveLength(1)
  f.state.locked = true; f.engine.emit('state-change', f.engine.getDeviceState())
  expect((await f.request('/api/pubkeys/batch', body, 'cached')).data.pubkeys).toHaveLength(1)
  expect(f.state.reads).toBe(1); expect(f.state.unlocks).toBe(0); expect(f.state.leases).toBe(1)
 })
 test('the original foreground read waits for unlock while health remains available', async () => {
  const f = fixture()
  const pending = f.request('/addresses/eth', { address_n: path }, 'foreground')
  await until(() => f.state.unlocks === 1)
  expect(f.state.reads).toBe(0); expect((await f.request('/api/v1/health/fast')).status).toBe(200)
  f.unlock(); expect((await pending).data.address).toBe(address)
  expect(f.state.reads).toBe(1); expect(f.state.releases).toBe(1); expect(f.state.focus).toBe(0)
 })
 test('two foreground reads share one unlock and retain separate serialized leases', async () => {
  const f = fixture()
  const first = f.request('/addresses/eth', { address_n: path }, 'foreground')
  await until(() => f.state.unlocks === 1)
  const second = f.request('/addresses/eth', { address_n: [...path.slice(0, -1), 1] }, 'foreground')
  await sleep(20); expect(f.state.reads).toBe(0)
  f.unlock(); expect((await first).status).toBe(200); expect((await second).status).toBe(200)
  expect(f.state.unlocks).toBe(1); expect(f.state.reads).toBe(2); expect(f.state.leases).toBe(2); expect(f.state.releases).toBe(2)
 })
 test('caller cancellation during unlock never dispatches its address read', async () => {
  const f = fixture(), abort = new AbortController()
  const pending = f.request('/addresses/eth', { address_n: path }, 'foreground', abort.signal).catch(error => error)
  await until(() => f.state.unlocks === 1); abort.abort(); await pending
  await until(() => f.state.focus === 0)
  expect(f.state.reads).toBe(0); expect((await f.request('/auth/pair')).data.paired).toBe(true)
 })
 test('session changes during unlock reject the original operation and release the lease', async () => {
  const f = fixture()
  const pending = f.request('/addresses/eth', { address_n: path }, 'foreground')
  await until(() => f.state.unlocks === 1); f.state.epoch++; f.unlock()
  expect((await pending).status).toBe(409); expect(f.state.reads).toBe(0); expect(f.state.releases).toBe(1); expect(f.state.focus).toBe(0)
 })
 test('a passphrase transition invalidates the previously warmed public cache', async () => {
  const f = fixture(false)
  await f.request('/addresses/eth', { address_n: path }, 'foreground')
  f.engine.emit('state-change', { state: 'needs_passphrase' }); f.state.locked = true
  expect((await f.request('/addresses/eth', { address_n: path }, 'cached')).status).toBe(423)
  expect(f.state.reads).toBe(1); expect(f.state.unlocks).toBe(0)
 })
 test('on-device verification always reaches the device even after a cache hit', async () => {
  const f = fixture(false)
  await f.request('/addresses/eth', { address_n: path }, 'foreground'); f.state.locked = true
  const pending = f.request('/addresses/eth', { address_n: path, show_display: true }, 'foreground')
  await until(() => f.state.unlocks === 1); expect(f.state.reads).toBe(1)
  f.unlock(); expect((await pending).status).toBe(200); expect(f.state.reads).toBe(2)
 })
 test('caller cancellation dismisses its pending approval without signing', async () => {
  const f = fixture(false), abort = new AbortController(); f.state.waitApproval = true
  const pending = f.request('/eth/sign', { address, message: '0x6162' }, undefined, abort.signal).catch(error => error)
  await until(() => f.state.approvals === 1); abort.abort(); await pending
  await until(() => f.state.releases === 1)
  expect(f.state.signs).toBe(0); expect(f.state.focus).toBe(0)
 })
 test('empty signing probes are rejected without unlocking or opening approval', async () => {
  const f = fixture()
  expect((await f.request('/eth/sign', {})).status).toBe(400)
  expect(f.state.unlocks).toBe(0); expect(f.state.approvals).toBe(0); expect(f.state.signs).toBe(0)
 })
 test('a signing approval follows unlock; rejecting it never signs', async () => {
  const f = fixture()
  const pending = f.request('/eth/sign', { address: address, message: '0x6162' })
  await until(() => f.state.unlocks === 1); expect(f.state.approvals).toBe(0)
  f.unlock(); expect((await pending).status).toBeGreaterThanOrEqual(400)
  expect(f.state.approvals).toBe(1); expect(f.state.signs).toBe(0); expect(f.state.releases).toBe(1)
 })
})
