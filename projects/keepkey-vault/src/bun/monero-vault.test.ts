import { expect, test } from 'bun:test'
import { createMoneroVault, type MoneroWatchSidecar } from './monero-vault'

// Published disposable address fixtures and dummy view bytes only. No USB,
// daemon, native firmware library or existing wallet is accessed by these tests.
const ADDRESS = '44jKQv6ZKMd5ecLLmkNJGi7azgSptEq8ki7TFiat1TfLfdDQ1tQ7ZYa3cRh7X2uRwvLDjddWh97ajeyhR2seKSECQeDx1WR'
const OTHER = '4Ahp23WfMrMFK3wYL2hLWQFGt87ZTeRkufS6JoQZu6MEFDokAQeGWmu9MA3GFq1yVLSJQbKJqVAn9F9DLYGpRzRAEXqAXKM'
const DUMMY_VIEW = new Uint8Array(32).fill(7)
function bytes(field: number, value: Uint8Array): Uint8Array { return new Uint8Array([field * 8 + 2, value.length, ...value]) }
function text(field: number, value: string): Uint8Array { return bytes(field, new TextEncoder().encode(value)) }
function combine(...values: Uint8Array[]) { return new Uint8Array(values.flatMap(value => [...value])) }
function reports(type: number, body: Uint8Array = new Uint8Array()): Uint8Array[] {
  const stream = new Uint8Array(8 + body.length); stream.set([35, 35])
  const view = new DataView(stream.buffer); view.setUint16(2, type); view.setUint32(4, body.length); stream.set(body, 8)
  const result: Uint8Array[] = []
  for (let offset = 0; offset < stream.length; offset += 63) {
    const report = new Uint8Array(64); report[0] = 63; report.set(stream.subarray(offset, offset + 63), 1); result.push(report)
  }
  return result
}
class Device {
  onButtonRequest: (() => void) | null = null
  sent: Array<{ type: number; report: Uint8Array; debug: boolean }> = []
  consumed: Uint8Array[] = []
  queue: Uint8Array[] = []
  addressBody = text(1, ADDRESS)
  watchBody = combine(bytes(1, DUMMY_VIEW), text(2, ADDRESS))
  pending = 0
  unsupported = false
  pinChallenge = false
  watchReadHook: (() => void) | null = null
  async writeChunk(report: Uint8Array, debug = false) {
    const type = (report[3] << 8) | report[4]
    this.sent.push({ type, report: report.slice(), debug })
    if (type === 540) {
      if (this.unsupported) this.queue.push(...reports(3, new Uint8Array([8, 1])))
      else if (this.pinChallenge) this.queue.push(...reports(18, new Uint8Array([8, 1])))
      else if (report[28] === 1) { this.pending = 541; this.queue.push(...reports(26)) }
      else this.queue.push(...reports(541, this.addressBody))
    } else if (type === 542) { this.pending = 543; this.queue.push(...reports(26)) }
    else if (type === 27) {
      this.queue.push(...reports(this.pending, this.pending === 543 ? this.watchBody : this.addressBody)); this.pending = 0
    } else if (type === 20) { this.queue.push(...reports(3, new Uint8Array([8, 4]))); this.pending = 0 }
  }
  silent = false
  disconnects = 0
  private hang: ((error: Error) => void) | null = null
  disconnect() { this.disconnects++; this.hang?.(new Error('disconnected')); this.hang = null }
  async readChunk() {
    if (this.silent) return new Promise<Uint8Array>((_, reject) => { this.hang = reject })
    const report = this.queue.shift()
    if (!report) throw new Error('Public fixture response exhausted')
    this.consumed.push(report)
    const type = report[1] === 35 && report[2] === 35 ? (report[3] << 8) | report[4] : -1
    if (type === 26) this.onButtonRequest?.()
    if (type === 543) this.watchReadHook?.()
    return report
  }
}
function fixture(emulator = false, replyMs?: { device: number; human: number }) {
  const delegate = new Device()
  let locked = false, reviews = 0, configures = 0, starts = 0, stops = 0
  let configuredKey: Uint8Array | null = null
  let configuredOptions: Record<string, unknown> | null = null
  const state = { state: 'ready', deviceId: 'PUBLIC-DEVICE-A', activeTransport: emulator ? 'emulator' : 'hid', isHiddenWallet: false, firmwareVersion: '7.17.0' }
  const config = { enabled: true, offline: false, daemonUrl: 'https://node.example', restoreHeight: 100 }
  const status = { network: 'mainnet' as const, address: ADDRESS, balanceAtomic: '84653050000', unlockedBalanceAtomic: '84653050000',
    walletHeight: 120, transactions: [{ txid: 'ab'.repeat(32), amountAtomic: '84653050000', confirmations: 12, locked: false, height: 108, type: 'in' }],
    monitorReady: true, updatedAt: new Date().toISOString(), canSend: false as const }
  const sidecar: MoneroWatchSidecar & { failure: boolean } = {
    failure: false,
    async startMoneroSidecar() { starts++ },
    stopMoneroSidecar() { stops++ },
    async configureMoneroWatch(options) {
      expect(locked).toBe(false)
      configures++; configuredKey = options.viewKey; configuredOptions = { ...options, viewKey: '[dummy key excluded]' }
      expect([...options.viewKey]).toEqual([...DUMMY_VIEW])
      return { ...status, transactions: status.transactions.map(tx => ({ ...tx })), viewKey: 'DO-NOT-EXPOSE', rpcPassword: 'DO-NOT-EXPOSE' }
    },
    async getMoneroWalletStatus() {
      if (this.failure) throw new Error('DO-NOT-EXPOSE rpc credential')
      return { ...status, transactions: status.transactions.map(tx => ({ ...tx })) }
    },
  }
  const transport = { delegate, async lockDuring<T>(operation: () => Promise<T>): Promise<T> {
    expect(locked).toBe(false); locked = true
    try { return await operation() } finally { locked = false }
  } }
  const engine = { isEmulator: emulator, wallet: { transport } as { transport: typeof transport } | null, emuDelegate: emulator ? delegate : null,
    currentSeedEthAddress: null as string | null, getDeviceState: () => ({ ...state }) }
  const confirm = async (operation: () => Promise<any>) => {
    expect(locked).toBe(true); delegate.onButtonRequest = () => { reviews++ }
    try { return await operation() } finally { delegate.onButtonRequest = null }
  }
  const api = createMoneroVault({ engine, confirm, getConfig: () => ({ ...config }), sidecar, ...(replyMs ? { replyMs } : {}) })
  return { api, delegate, engine, config, state, status, sidecar,
    counts: () => ({ reviews, configures, starts, stops }), key: () => configuredKey, options: () => configuredOptions }
}

test('status alone cannot export keys, start a sidecar or prompt the device', async () => {
  const f = fixture(), value = await f.api.getStatus()
  expect(value.available).toBe(false)
  expect(value.deviceReady).toBe(true)
  expect(f.counts().configures).toBe(0)
  expect(f.counts().starts).toBe(0)
  expect(f.delegate.sent).toHaveLength(0)
})

test('physical connection uses real 540 then explicitly approved 542 and ACKs without debug decisions', async () => {
  const f = fixture(), value = await f.api.connect()
  expect(value.address).toBe(ADDRESS)
  expect(value.monitorReady).toBe(true)
  expect(value.canSend).toBe(false)
  expect(value.spendStateKnown).toBe(false)
  expect(f.delegate.sent.map(item => item.type)).toEqual([540, 542, 27])
  expect(f.delegate.sent.every(item => !item.debug)).toBe(true)
  expect(f.counts()).toMatchObject({ reviews: 0, configures: 1, starts: 1 })
  expect(f.options()).toMatchObject({ address: ADDRESS, network: 'mainnet', daemonUrl: f.config.daemonUrl, restoreHeight: 100 })
  expect(f.key()?.every(byte => byte === 0)).toBe(true)
  expect(f.delegate.consumed.every(report => report.every(byte => byte === 0))).toBe(true)
  expect(JSON.stringify(value)).not.toContain('DO-NOT-EXPOSE')
  expect(JSON.stringify(value)).not.toContain('viewKey')
})

test('emulator wraps both address display and view export in the interactive confirmation gate', async () => {
  const f = fixture(true), value = await f.api.connect({ showDisplay: true })
  expect(value.available).toBe(true)
  expect(f.counts().reviews).toBe(2)
  expect(f.delegate.sent.map(item => item.type)).toEqual([540, 27, 542, 27])
  expect(f.delegate.sent.some(item => item.debug || item.type === 100)).toBe(false)
})

test('address/view-key identity mismatch, duplicate fields and invalid key dimensions never configure a sidecar', async () => {
  for (const body of [combine(bytes(1, DUMMY_VIEW), text(2, OTHER)), combine(bytes(1, DUMMY_VIEW), bytes(1, DUMMY_VIEW), text(2, ADDRESS)),
    combine(bytes(1, new Uint8Array(31).fill(7)), text(2, ADDRESS)), combine(bytes(1, new Uint8Array(32)), text(2, ADDRESS))]) {
    const f = fixture(); f.delegate.watchBody = body
    await expect(f.api.connect()).rejects.toThrow()
    expect(f.counts().configures).toBe(0)
    expect(f.delegate.consumed.every(report => report.every(byte => byte === 0))).toBe(true)
  }
})

test('a device change during private view-key response revokes monitoring and wipes response bytes', async () => {
  const f = fixture()
  f.delegate.watchReadHook = () => { f.state.deviceId = 'PUBLIC-DEVICE-B' }
  await expect(f.api.connect()).rejects.toThrow('changed')
  expect(f.counts().configures).toBe(0)
  expect(f.delegate.consumed.every(report => report.every(byte => byte === 0))).toBe(true)
})

test('sidecar poll failure preserves the last known funds and exposes only a fixed diagnostic', async () => {
  const f = fixture(); await f.api.connect(); f.sidecar.failure = true
  const value = await f.api.getStatus()
  expect(value.balanceAtomic).toBe('84653050000')
  expect(value.unlockedBalanceAtomic).toBe('84653050000')
  expect(value.monitorReady).toBe(false)
  expect(value.error).toContain('last wallet update')
  expect(JSON.stringify(value)).not.toContain('DO-NOT-EXPOSE')
})

test('a sidecar returning a different wallet invalidates the binding without exposing that wallet balance', async () => {
  const f = fixture(); await f.api.connect(); f.status.address = OTHER
  const value = await f.api.getStatus()
  expect(value.available).toBe(false)
  expect(value.address).toBe('')
  expect(value.error).toContain('wallet changed')
  expect(f.counts().stops).toBeGreaterThan(1)
})

test('invalidating while worker configuration awaits cannot resurrect the authorization and still wipes the key', async () => {
  const f = fixture()
  let entered!: () => void, release!: () => void, key: Uint8Array | null = null
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const resume = new Promise<void>(resolve => { release = resolve })
  f.sidecar.configureMoneroWatch = async options => { key = options.viewKey; entered(); await resume; return f.status }
  const connecting = f.api.connect()
  await waiting; f.api.invalidate(); release()
  await expect(connecting).rejects.toThrow('changed')
  expect((key as Uint8Array | null)?.every(byte => byte === 0)).toBe(true)
  expect((await f.api.getStatus()).available).toBe(false)
})

test('feature, offline, identity, passphrase and node changes revoke the previous watch binding', async () => {
  for (const change of ['feature', 'offline', 'device', 'wallet', 'seed', 'daemon', 'height', 'locked']) {
    const f = fixture(); await f.api.connect()
    if (change === 'feature') f.config.enabled = false
    else if (change === 'offline') f.config.offline = true
    else if (change === 'device') f.state.deviceId = 'PUBLIC-DEVICE-B'
    else if (change === 'wallet') f.engine.wallet = { transport: { ...f.engine.wallet!.transport } }
    else if (change === 'seed') f.engine.currentSeedEthAddress = 'PUBLIC-DIFFERENT-SEED'
    else if (change === 'daemon') f.config.daemonUrl = 'https://different.example'
    else if (change === 'height') f.config.restoreHeight = 101
    else f.state.state = 'needs_pin'
    const value = await f.api.getStatus()
    expect(value.available).toBe(false)
    expect(value.address).toBe('')
    expect(value.transactions).toEqual([])
    expect(f.counts().stops).toBeGreaterThan(1)
  }
})

test('disabled, offline, locked and insecure node configurations refuse connect before USB or worker startup', async () => {
  for (const change of ['disabled', 'offline', 'locked', 'http', 'credentials', 'height']) {
    const f = fixture()
    if (change === 'disabled') f.config.enabled = false
    else if (change === 'offline') f.config.offline = true
    else if (change === 'locked') f.state.state = 'needs_pin'
    else if (change === 'http') f.config.daemonUrl = 'http://node.example'
    else if (change === 'credentials') f.config.daemonUrl = 'https://user:password@node.example'
    else f.config.restoreHeight = -1
    await expect(f.api.connect()).rejects.toThrow()
    expect(f.delegate.sent).toHaveLength(0)
    expect(f.counts().starts).toBe(0)
  }
})

test('unexpected PIN challenge is cancelled and never answered by the raw bridge', async () => {
  const f = fixture(); f.delegate.pinChallenge = true
  await expect(f.api.connect()).rejects.toThrow('Unlock')
  expect(f.delegate.sent.map(item => item.type)).toEqual([540, 20])
  expect(f.counts().configures).toBe(0)
})

test('firmware older than 7.17.0 refuses connect before any USB traffic', async () => {
  const f = fixture(); f.state.firmwareVersion = '7.16.0'
  await expect(f.api.connect()).rejects.toThrow('7.17.0')
  expect(f.delegate.sent).toHaveLength(0)
  expect(f.counts().configures).toBe(0)
})

test('unsupported device firmware fails without a static address or a view-key request', async () => {
  const f = fixture(); f.delegate.unsupported = true
  await expect(f.api.connect()).rejects.toThrow('rejected')
  expect(f.delegate.sent.map(item => item.type)).toEqual([540])
  expect(f.counts().configures).toBe(0)
  expect((await f.api.getStatus()).available).toBe(false)
})

test('exact uint64 strings remain exact; invalid and stale monitor data cannot claim readiness', async () => {
  const f = fixture(); f.status.balanceAtomic = '18446744073709551615'; await f.api.connect()
  expect((await f.api.getStatus()).balanceAtomic).toBe('18446744073709551615')
  f.status.updatedAt = new Date(Date.now() - 121000).toISOString()
  expect((await f.api.getStatus()).monitorReady).toBe(false)
  f.status.unlockedBalanceAtomic = '18446744073709551616'
  expect((await f.api.getStatus()).balanceAtomic).toBe('18446744073709551615')
  expect((await f.api.getStatus()).monitorReady).toBe(false)
})

test('getAddress still derives from the bound device and revokes if the selected wallet changed', async () => {
  const f = fixture(); await f.api.connect()
  expect(await f.api.getAddress({ showDisplay: false })).toEqual({ address: ADDRESS, network: 'mainnet', displayed: false })
  f.delegate.addressBody = text(1, OTHER)
  await expect(f.api.getAddress()).rejects.toThrow('changed')
  expect((await f.api.getStatus()).available).toBe(false)
})

test('malformed display options are rejected before any approval or USB traffic', async () => {
  const f = fixture()
  await expect(f.api.connect({ showDisplay: 'true' as unknown as boolean })).rejects.toThrow('display option')
  await expect(f.api.getAddress({ showDisplay: 1 as unknown as boolean })).rejects.toThrow('display option')
  expect(f.delegate.sent).toHaveLength(0)
})

test('saved HTTP loopback daemon settings can connect through the device bridge', async () => {
  for (const daemonUrl of ['http://127.0.0.1:18081', 'http://localhost:18081', 'http://[::1]:18081']) {
    const f = fixture()
    f.config.daemonUrl = daemonUrl
    expect((await f.api.connect()).connected).toBe(true)
    expect(f.options()?.daemonUrl).toBe(daemonUrl)
    f.api.stop()
  }
})

test('a device that never answers ends the read within its bound, disconnects and frees the lock', async () => {
  const f = fixture(false, { device: 50, human: 200 })
  f.delegate.silent = true
  const started = Date.now()
  await expect(f.api.connect()).rejects.toThrow('did not answer')
  expect(Date.now() - started).toBeLessThan(2000)
  expect(f.delegate.disconnects).toBe(1)
  expect(f.counts().configures).toBe(0)
  // the transport lock was released: a later request runs instead of queuing forever
  f.delegate.silent = false
  f.delegate.queue.length = 0 // replies the silent device scripted for the abandoned request
  const second = await f.api.connect().then(() => 'ok', (e: any) => String(e?.message ?? e))
  expect(second).toBe('ok')
})
