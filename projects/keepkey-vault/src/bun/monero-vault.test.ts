import { expect, test } from 'bun:test'
import { createMoneroVault, type MoneroWatchSidecar } from './monero-vault'
import { Database } from 'bun:sqlite'
import { createMoneroWatchStore, type MoneroWatchStore } from './monero-watch-store'
import { MONERO_STANDARD_WALLET_REQUIRED } from '../shared/monero-wallet-policy'

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
  constructor(public research = false) {}
  failureCode = 1
  failureBody: Uint8Array | null = null
  watchScreens = 1
  private approvalsLeft = 0
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
    const [address, addressReply, watch, watchReply] = this.research ? [540, 541, 542, 543] : [1800, 1801, 1802, 1803]
    this.sent.push({ type, report: report.slice(), debug })
    if (type === address) {
      if (this.unsupported) this.queue.push(...reports(3, this.failureBody ?? combine(new Uint8Array([8, this.failureCode]), text(2, "DO-NOT-EXPOSE firmware detail"))))
      else if (this.pinChallenge) this.queue.push(...reports(18, new Uint8Array([8, 1])))
      else if (report[28] === 1) { this.pending = addressReply; this.queue.push(...reports(26)) }
      else this.queue.push(...reports(addressReply, this.addressBody))
    } else if (type === watch) { this.pending = watchReply; this.approvalsLeft = this.watchScreens - 1; this.queue.push(...reports(26)) }
    else if (type === 27) {
      if (this.approvalsLeft-- > 0) { this.queue.push(...reports(26)); return }
      this.queue.push(...reports(this.pending, this.pending === watchReply ? this.watchBody : this.addressBody)); this.pending = 0
    } else if (type === 20) { this.queue.push(...reports(3, new Uint8Array([8, 4]))); this.pending = 0 }
    else this.queue.push(...reports(3, new Uint8Array([8, 1])))
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
    if (type === (this.research ? 543 : 1803)) this.watchReadHook?.()
    return report
  }
}
function fixture(emulator = false, replyMs?: { device: number; human: number }, watchStore?: MoneroWatchStore, onTransportFailure?: (transport: unknown) => void) {
  const delegate = new Device(emulator)
  let locked = false, reviews = 0, configures = 0, starts = 0, stops = 0
  let configuredKey: Uint8Array | null = null
  let configuredOptions: Record<string, unknown> | null = null
  const state = { state: 'ready', deviceId: 'PUBLIC-DEVICE-A', activeTransport: emulator ? 'emulator' : 'hid', isHiddenWallet: false, firmwareVersion: '7.17.0', firmwareHash: undefined as string | undefined, capabilities: emulator ? [] : [31] }
  const config = { enabled: true, offline: false, daemonUrl: 'https://node.example', restoreHeight: 100 }
  const status = { network: 'mainnet' as const, address: ADDRESS, balanceAtomic: '84653050000', unlockedBalanceAtomic: '84653050000',
    walletHeight: 120, transactions: [{ txid: 'ab'.repeat(32), amountAtomic: '84653050000', confirmations: 12, locked: false, height: 108, type: 'in' }],
    monitorReady: true, updatedAt: new Date().toISOString(), canSend: false as const }
  const sidecar: MoneroWatchSidecar & { failure: boolean } = {
    failure: false,
    hasMoneroSigningTools: () => true,
    isMoneroSignerWorkerReady: () => true,
    isMoneroSendReady: () => true,
    async createMoneroTransfer() { throw new Error("Watch fixture cannot build transactions") },
    async relayMoneroTransaction() { throw new Error("Watch fixture cannot broadcast") },
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
  const coreVerifier = { available: () => true, prepare: () => { throw new Error("Watch fixture cannot sign") } }
  const api = createMoneroVault({ engine, confirm, getConfig: () => ({ ...config }), sidecar, watchStore, onTransportFailure, signingEmulator: () => emulator, coreVerifier, ...(replyMs ? { replyMs } : {}) })
  return { api, delegate, engine, config, state, status, sidecar, coreVerifier,
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

test('physical connection uses firmware 1800 then explicitly approved 1802 and ACKs without debug decisions', async () => {
  const f = fixture(), value = await f.api.connect()
  expect(value.address).toBe(ADDRESS)
  expect(value.monitorReady).toBe(true)
  expect(value.canSend).toBe(false)
  expect(value.spendStateKnown).toBe(false)
  expect(f.delegate.sent.map(item => item.type)).toEqual([1800, 1802, 27])
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

test('tool validation precedes device consent and connection progress clears on completion', async () => {
  const f = fixture()
  let release!: () => void, started!: () => void
  const waiting = new Promise<void>(resolve => { started = resolve })
  f.sidecar.startMoneroSidecar = async () => { started(); await new Promise<void>(resolve => { release = resolve }) }
  const connection = f.api.connect()
  expect((await f.api.getStatus()).connectionPhase).toBe('wallet')
  expect(f.delegate.sent).toHaveLength(0)
  await waiting
  expect((await f.api.getStatus()).connectionPhase).toBe('wallet')
  release()
  expect((await connection).connectionPhase).toBeUndefined()
  expect((await f.api.getStatus()).connectionPhase).toBeUndefined()
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
  expect(f.delegate.sent.map(item => item.type)).toEqual([1800, 20])
  expect(f.counts().configures).toBe(0)
})

test('missing signing capability refuses onboarding before any device traffic', async () => {
  const f = fixture(); f.state.capabilities = []
  await expect(f.api.connect()).rejects.toThrow('hardware signing')
  await expect(f.api.getAddress()).rejects.toThrow('hardware signing')
  expect(await f.api.getStatus()).toMatchObject({signingReady:false,sendBlocked:'firmware',address:''})
  expect(f.delegate.sent).toHaveLength(0)
  expect(f.counts().configures).toBe(0)
})

test('unsupported device firmware fails without a static address or a view-key request', async () => {
  const f = fixture(); f.delegate.unsupported = true
  await expect(f.api.connect()).rejects.toThrow('does not recognize Monero request 1800')
  expect(f.delegate.sent.map(item => item.type)).toEqual([1800])
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
  expect(await f.api.getAddress({ showDisplay: false })).toEqual({ address: ADDRESS, network: 'mainnet', displayed: false, minor: 0 })
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


test('saved physical monitoring access reconnects without exporting the view key again; address verification still reaches hardware',async()=>{
 const db=new Database(':memory:')
 const store=createMoneroWatchStore({database:()=>db,profile:'test',key:async()=>new Uint8Array(32).fill(9)})
 const f=fixture(false,undefined,store)
 f.engine.currentSeedEthAddress='0x'+'a'.repeat(40)
 try {
  await f.api.connect()
  expect(f.delegate.sent.filter(x=>x.type===1802)).toHaveLength(1)
  f.api.invalidate();f.delegate.sent=[]
  await f.api.connect()
  expect(f.delegate.sent.map(x=>x.type)).toEqual([1800])
  expect([...f.key()!]).toEqual(Array(32).fill(0))
  f.delegate.sent=[]
  await f.api.getAddress({showDisplay:false})
  expect(f.delegate.sent).toHaveLength(0)
  await f.api.getAddress({showDisplay:true})
  expect(f.delegate.sent.map(x=>x.type)).toEqual([1800,27])
  f.engine.currentSeedEthAddress='0x'+'b'.repeat(40);f.api.invalidate();f.delegate.sent=[]
  await f.api.connect()
  expect(f.delegate.sent.some(x=>x.type===1802)).toBe(true)
 }finally{db.close()}
})

test('missing seed identity never reads or writes saved monitoring access',async()=>{
 const db=new Database(':memory:')
 const store=createMoneroWatchStore({database:()=>db,profile:'test',key:async()=>{throw Error('must not access OS store')}})
 const f=fixture(false,undefined,store)
 try {await f.api.connect();f.api.invalidate();await f.api.connect();expect(f.delegate.sent.filter(x=>x.type===1802)).toHaveLength(2)}
 finally{db.close()}
})


test('a Monero read timeout invalidates the current engine transport instead of leaving it ready',async()=>{
 let recovered=0
 const f=fixture(false,{device:30,human:100},undefined,transport=>{
  expect(transport).toBe(f.engine.wallet!.transport);recovered++;f.engine.wallet=null;f.state.state='disconnected'
 })
 f.delegate.silent=true
 await expect(f.api.connect()).rejects.toThrow('did not answer')
 expect(recovered).toBe(1)
 expect(await f.api.getStatus()).toMatchObject({available:false,deviceReady:false})
 expect(f.counts().configures).toBe(0)
})

test('LIBUSB_ERROR_NOT_FOUND requests a fresh transport without replaying the failed operation',async()=>{
 let recovered=0,writes=0
 const f=fixture(false,undefined,undefined,()=>{recovered++;f.engine.wallet=null;f.state.state='disconnected'})
 f.delegate.writeChunk=async()=>{writes++;throw Error('transferOut error: Error: LIBUSB_ERROR_NOT_FOUND')}
 await expect(f.api.connect()).rejects.toThrow('Unable to connect')
 expect(recovered).toBe(1);expect(writes).toBeLessThanOrEqual(2)
 expect(await f.api.getStatus()).toMatchObject({available:false,deviceReady:false})
 expect(f.counts().configures).toBe(0)
})

test('a normal cancelled Monero approval does not trigger transport recovery',async()=>{
 let recovered=0
 const f=fixture(false,undefined,undefined,()=>{recovered++});f.delegate.unsupported=true;f.delegate.failureCode=4
 await expect(f.api.connect()).rejects.toThrow('cancelled the Monero request')
 expect(recovered).toBe(0)
})


test('approved monitoring access survives an unreachable node, so another node needs no repeated export',async()=>{
 const db=new Database(':memory:')
 const store=createMoneroWatchStore({database:()=>db,profile:'test',key:async()=>new Uint8Array(32).fill(9)})
 const f=fixture(false,undefined,store);f.engine.currentSeedEthAddress='0x'+'a'.repeat(40)
 const configure=f.sidecar.configureMoneroWatch
 f.sidecar.configureMoneroWatch=async()=>{throw Error('The Monero daemon is unavailable')}
 try {
  await expect(f.api.connect()).rejects.toThrow()
  f.sidecar.configureMoneroWatch=configure;f.config.daemonUrl='https://other.example';f.delegate.sent=[]
  await f.api.connect()
  expect(f.delegate.sent.map(x=>x.type)).toEqual([1800])
 }finally{db.close()}
})

for (const identity of ['device-state', 'engine-session'] as const) test(`hidden ${identity} blocks every wallet action before transport, cache, pending files or sidecar access`, async () => {
  const f = fixture()
  if (identity === 'device-state') f.state.isHiddenWallet = true
  else Object.defineProperty(f.engine, 'isPassphraseWallet', { get: () => true })
  const calls: string[] = []
  const store: MoneroWatchStore = {
    async loadWatch() { calls.push('load-watch'); return null }, async saveWatch() { calls.push('save-watch') },
    async loadAddress() { calls.push('load-address'); return null }, async saveAddress() { calls.push('save-address') },
    async loadImages() { calls.push('load-images'); return null }, async saveImages() { calls.push('save-images') },
  }
  const api = createMoneroVault({ engine: f.engine, sidecar: f.sidecar, getConfig: () => ({ ...f.config }), watchStore: store,
    pendingStore: { load() { calls.push('load-pending'); return [] }, save() { calls.push('save-pending') },
      loadGuards() { calls.push('load-guards'); return [] }, saveGuards() { calls.push('save-guards') } } })
  expect(calls).toEqual([]) // Factory construction must not hydrate hidden identities.
  for (const operation of [() => api.connect(), () => api.getAddress(), () => api.syncKeyImages(),
    () => api.prepareSend({ address: OTHER, amountAtomic: '1' }), () => api.send({ prepareId: 'expired' }),
    () => api.retryRelay(), () => api.discardPending({ confirm: true })]) {
    await expect(operation()).rejects.toThrow(MONERO_STANDARD_WALLET_REQUIRED)
  }
  expect(() => api.pendingCount()).toThrow(MONERO_STANDARD_WALLET_REQUIRED)
  expect(await api.getStatus()).toMatchObject({ available: false, address: '', transactions: [], canSend: false,
    deviceReady: false, error: MONERO_STANDARD_WALLET_REQUIRED })
  expect(calls).toEqual([])
  expect(f.delegate.sent).toHaveLength(0)
  expect(f.counts().starts).toBe(0)
  expect(f.counts().configures).toBe(0)
})

test('a hidden transition during device consent cannot save a watch identity or configure a wallet', async () => {
  const f = fixture()
  let saved = 0
  const store: MoneroWatchStore = {
    async loadWatch() { return null }, async saveWatch() { saved++ }, async loadAddress() { return null },
    async saveAddress() { saved++ }, async loadImages() { return null }, async saveImages() { saved++ },
  }
  const api = createMoneroVault({ engine: f.engine, sidecar: f.sidecar, getConfig: () => ({ ...f.config }), watchStore: store, coreVerifier: {available: () => true,prepare: () => {throw Error("fixture cannot sign")}} })
  f.delegate.watchReadHook = () => { f.state.isHiddenWallet = true }
  await expect(api.connect()).rejects.toThrow(MONERO_STANDARD_WALLET_REQUIRED)
  expect(saved).toBe(0)
  expect(f.counts().starts).toBe(1)
  expect(f.counts().configures).toBe(0)
  expect(await api.getStatus()).toMatchObject({ address: '', available: false, error: MONERO_STANDARD_WALLET_REQUIRED })
})

test('a hidden transition while polling clears the prior monitor instead of returning its cached balance', async () => {
  const f = fixture()
  await f.api.connect()
  f.sidecar.getMoneroWalletStatus = async () => { f.state.isHiddenWallet = true; return f.status }
  const status = await f.api.getStatus()
  expect(status).toMatchObject({ available: false, address: '', balanceAtomic: '0', transactions: [], error: MONERO_STANDARD_WALLET_REQUIRED })
  expect(f.counts().stops).toBeGreaterThan(0)
})

test('hidden policy does not erase previously saved pending transactions and standard-wallet access can resume', async () => {
  const f = fixture()
  let reads = 0, saves = 0
  const record = { wallet: `PUBLIC-DEVICE-A:${ADDRESS}`, txid: 'ab'.repeat(32), txHex: '00', createdAt: new Date().toISOString() }
  const api = createMoneroVault({ engine: f.engine, sidecar: f.sidecar, getConfig: () => ({ ...f.config }),
    pendingStore: { load() { reads++; return [record] }, save() { saves++ } } })
  expect(reads).toBe(0)
  expect(api.pendingCount()).toBe(1)
  f.state.isHiddenWallet = true
  expect((await api.getStatus()).unrelayedTxid).toBeUndefined()
  expect(() => api.pendingCount()).toThrow(MONERO_STANDARD_WALLET_REQUIRED)
  expect(saves).toBe(0)
  f.state.isHiddenWallet = false
  expect(api.pendingCount()).toBe(1)
  expect(reads).toBe(1)
  expect(saves).toBe(0)
})

test('a hidden connect does not create the monitoring table or request an OS storage key', async () => {
  const db = new Database(':memory:')
  const f = fixture(); f.state.isHiddenWallet = true; f.engine.currentSeedEthAddress = '0x' + 'c'.repeat(40)
  let databaseReads = 0, keyReads = 0
  const store = createMoneroWatchStore({ database: () => { databaseReads++; return db }, profile: 'synthetic-hidden-policy',
    key: async () => { keyReads++; return new Uint8Array(32).fill(9) } })
  const api = createMoneroVault({ engine: f.engine, sidecar: f.sidecar, getConfig: () => ({ ...f.config }), watchStore: store })
  try {
    await expect(api.connect()).rejects.toThrow(MONERO_STANDARD_WALLET_REQUIRED)
    expect(databaseReads).toBe(0)
    expect(keyReads).toBe(0)
    expect(db.query("SELECT count(*) AS count FROM sqlite_master WHERE name='monero_watch_cache'").get()).toEqual({ count: 0 })
    expect(f.delegate.sent).toHaveLength(0)
  } finally { api.stop(); db.close() }
})

// Numeric IDs are independently copied from device-protocol at firmware 66df3e24c.
test('alpha firmware view export acknowledges both consent screens, without a debug decision', async () => {
  const f = fixture(); f.delegate.watchScreens = 2
  await f.api.connect()
  expect(f.delegate.sent.map(x => x.type)).toEqual([1800, 1802, 27, 27])
  expect(f.delegate.sent.every(x => !x.debug)).toBe(true)
})

test('firmware failure codes distinguish unsupported requests, cancellation and locked wallets without leaking detail', async () => {
  for (const [code, expected] of [[1, 'does not recognize Monero request 1800'], [3, 'invalid Monero request'],
    [4, 'cancelled the Monero request'], [5, 'Unlock the KeepKey'], [6, 'PIN entry was cancelled'],
    [7, 'PIN was invalid'], [11, 'not initialized'], [99, 'firmware error'], [90, 'failure code 90']] as const) {
    const f = fixture(); f.delegate.unsupported = true; f.delegate.failureCode = code
    const error = await f.api.connect().catch(error => error)
    expect(error.message).toContain(expected)
    expect(error.message).not.toContain('DO-NOT-EXPOSE')
    expect(f.counts().configures).toBe(0)
    expect(f.delegate.sent).toHaveLength(1)
    expect(f.delegate.consumed.every(report => report.every(byte => byte === 0))).toBe(true)
  }
})

test('research firmware without the signing capability cannot expose deposit addresses', async () => {
  for (const hash of ['9bc7798fb71a744c23a81cb7987645b7b5418d16fd035acc00770d57d4ae4928',
    '123af6de3b5ddbc1eeb94568825d1bb8107079bc9100ac67f9f6162ca34e2f83']) {
    const f = fixture(); f.state.firmwareHash = hash; f.state.capabilities = []; f.delegate.research = true
    await expect(f.api.connect()).rejects.toThrow('hardware signing')
    expect(f.delegate.sent).toHaveLength(0)
  }
})

test('malformed, duplicate or absent firmware failure codes never expose the device message', async () => {
  for (const body of [text(2, 'DO-NOT-EXPOSE'), combine(new Uint8Array([8, 1, 8, 4]), text(2, 'DO-NOT-EXPOSE')), new Uint8Array([8, 128])]) {
    const f = fixture(); f.delegate.unsupported = true; f.delegate.failureBody = body
    await expect(f.api.connect()).rejects.toThrow('without a valid failure code')
    expect(f.counts().configures).toBe(0)
    expect(f.delegate.consumed.every(report => report.every(byte => byte === 0))).toBe(true)
  }
})

test('capability firmware connects independently of version or build hash', async () => {
  const f = fixture(); f.state.firmwareVersion = '7.16.0'
  await f.api.connect()
  expect(f.delegate.sent.map(x => x.type)).toEqual([1800, 1802, 27])
})


test('missing native verifier or wallet tools blocks onboarding and deposit addresses before device traffic', async () => {
  for (const missing of ['native', 'wallet-tools']) {
    const f = fixture()
    if (missing === 'native') f.coreVerifier.available = () => false
    else f.sidecar.hasMoneroSigningTools = () => false
    await expect(f.api.connect()).rejects.toThrow('missing required Monero wallet tools')
    await expect(f.api.getAddress()).rejects.toThrow('missing required Monero wallet tools')
    expect(f.delegate.sent).toHaveLength(0)
    expect(f.counts()).toMatchObject({ starts: 0, configures: 0 })
    expect(await f.api.getStatus()).toMatchObject({ signingReady: false, address: '', sendBlocked: 'adapter' })
  }
})

test('worker startup failure cannot expose a deposit address despite valid signing-tool metadata', async () => {
  const f = fixture()
  f.sidecar.isMoneroSignerWorkerReady = () => false
  await expect(f.api.connect()).rejects.toThrow('missing required Monero wallet tools')
  await expect(f.api.getAddress()).rejects.toThrow()
  expect(f.delegate.sent).toHaveLength(0)
  expect(f.counts().configures).toBe(0)
  expect((await f.api.getStatus()).address).toBe('')
})

test('signing dependencies are rechecked after worker startup before device key consent', async () => {
  const f = fixture()
  f.sidecar.startMoneroSidecar = async () => { f.coreVerifier.available = () => false }
  await expect(f.api.connect()).rejects.toThrow('missing required Monero wallet tools')
  expect(f.delegate.sent).toHaveLength(0)
  expect(f.counts().configures).toBe(0)
})

test('losing signing dependencies during wallet setup rejects onboarding and wipes approved view bytes', async () => {
  const f = fixture(), configure = f.sidecar.configureMoneroWatch
  f.sidecar.configureMoneroWatch = async options => {
    const status = await configure(options)
    f.coreVerifier.available = () => false
    return status
  }
  await expect(f.api.connect()).rejects.toThrow('missing required Monero wallet tools')
  expect(f.key()?.every(byte => byte === 0)).toBe(true)
  expect(f.delegate.consumed.every(report => report.every(byte => byte === 0))).toBe(true)
  expect(await f.api.getStatus()).toMatchObject({ signingReady: false, address: '', available: false })
})

test('a previously connected wallet cannot use cached deposit addresses after the signer worker becomes unavailable', async () => {
  const f = fixture()
  await f.api.connect()
  const before = f.delegate.sent.length
  f.sidecar.isMoneroSignerWorkerReady = () => false
  await expect(f.api.getAddress()).rejects.toThrow()
  expect(f.delegate.sent).toHaveLength(before)
})


test('an unconnected healthy signer cannot expose a deposit address before completing onboarding', async () => {
  const f = fixture()
  expect((await f.api.getStatus()).signingReady).toBe(true)
  await expect(f.api.getAddress()).rejects.toThrow('Connect the Monero watch wallet first')
  expect(f.delegate.sent).toHaveLength(0)
  expect(f.counts()).toMatchObject({ starts: 0, configures: 0 })
})

const CACHE_SEED='0x'+'11'.repeat(20)
const CACHE_SCOPE=JSON.stringify(['mainnet',[0x8000002c,0x80000080,0x80000000],'PUBLIC-DEVICE-A',CACHE_SEED,false])
const SAVED_BALANCE={balanceAtomic:'84653050000',unlockedBalanceAtomic:'84653050000',walletHeight:120,updatedAt:'2026-01-01T12:00:00.000Z',spendStateKnown:true}
function balanceStore(snapshot=SAVED_BALANCE) {
 let saved={...snapshot},loads=0,writes=0
 const store:MoneroWatchStore={async loadWatch(){return null},async saveWatch(){},async loadAddress(){return null},async saveAddress(){},async loadImages(){return null},async saveImages(){},
  async loadBalance(scope){loads++;return scope===CACHE_SCOPE?{...saved}:null},async saveBalance(scope,_primary,value){if(scope!==CACHE_SCOPE)throw Error('wrong wallet');writes++;saved={...value}}}
 return {store,counts:()=>({loads,writes}),saved:()=>({...saved})}
}
test('startup and offline polling restore the wallet-scoped balance without device I/O or spend authority',async()=>{
 const cache=balanceStore(),f=fixture(false,undefined,cache.store);f.engine.currentSeedEthAddress=CACHE_SEED
 const status=await f.api.getStatus()
 expect(status).toMatchObject({available:false,canSend:false,monitorReady:false,cachedBalance:SAVED_BALANCE})
 expect(f.delegate.sent).toHaveLength(0);expect(f.counts().starts).toBe(0)
 f.config.offline=true
 expect(await f.api.getStatus()).toMatchObject({canSend:false,cachedBalance:SAVED_BALANCE})
 expect(cache.counts().writes).toBe(0)
 f.state.isHiddenWallet=true
 expect((await f.api.getStatus()).cachedBalance).toBeUndefined()
 f.state.isHiddenWallet=false;f.engine.currentSeedEthAddress='0x'+'22'.repeat(20)
 expect((await f.api.getStatus()).cachedBalance).toBeUndefined()
 f.engine.currentSeedEthAddress=CACHE_SEED
 expect((await f.api.getStatus()).cachedBalance).toEqual(SAVED_BALANCE)
 f.config.enabled=false
 expect((await f.api.getStatus()).cachedBalance).toBeUndefined()
})
test('scanning retains the prior snapshot and a fresh complete zero replaces it across a vault restart',async()=>{
 const cache=balanceStore(),f=fixture(false,undefined,cache.store);f.engine.currentSeedEthAddress=CACHE_SEED
 await f.api.getStatus();f.status.monitorReady=false;f.status.walletHeight=0;f.status.balanceAtomic='0';f.status.unlockedBalanceAtomic='0'
 expect(await f.api.connect()).toMatchObject({monitorReady:false,cachedBalance:SAVED_BALANCE})
 expect(cache.counts().writes).toBe(0)
 f.status.monitorReady=true;f.status.walletHeight=200;f.status.updatedAt=new Date().toISOString()
 const current=await f.api.getStatus()
 expect(current.cachedBalance).toMatchObject({balanceAtomic:'0',walletHeight:200,updatedAt:f.status.updatedAt})
 await f.api.flushBalanceCache()
 expect(cache.counts().writes).toBe(1)
 const restarted=fixture(false,undefined,cache.store);restarted.engine.currentSeedEthAddress=CACHE_SEED
 expect((await restarted.api.getStatus()).cachedBalance).toEqual(current.cachedBalance!)
 expect(restarted.delegate.sent).toHaveLength(0)
})
test('a cached read resolving after a hidden-wallet switch cannot reveal the old balance',async()=>{
 const cache=balanceStore();let resolve!:(v:typeof SAVED_BALANCE)=>void
 cache.store.loadBalance=async()=>new Promise(r=>{resolve=r})
 const f=fixture(false,undefined,cache.store);f.engine.currentSeedEthAddress=CACHE_SEED
 const pending=f.api.getStatus();f.state.isHiddenWallet=true;resolve(SAVED_BALANCE)
 expect((await pending).cachedBalance).toBeUndefined()
 expect(f.delegate.sent).toHaveLength(0)
})

test('an unverified received total cannot replace a previously spend-known cache and normal close can flush the last zero',async()=>{
 const cache=balanceStore(),f=fixture(false,undefined,cache.store);f.engine.currentSeedEthAddress=CACHE_SEED
 await f.api.getStatus();f.status.balanceAtomic='99999999999';f.status.unlockedBalanceAtomic='99999999999'
 expect((await f.api.connect()).cachedBalance).toEqual(SAVED_BALANCE)
 await f.api.flushBalanceCache();expect(cache.counts().writes).toBe(0)
 f.status.balanceAtomic='0';f.status.unlockedBalanceAtomic='0';f.status.updatedAt=new Date().toISOString()
 await f.api.getStatus();await f.api.flushBalanceCache()
 expect(cache.saved().balanceAtomic).toBe('0')
})

test('connecting before the first status poll preserves the spend-known snapshot already on disk',async()=>{
 const cache=balanceStore(),f=fixture(false,undefined,cache.store);f.engine.currentSeedEthAddress=CACHE_SEED
 f.status.balanceAtomic='99999999999';f.status.unlockedBalanceAtomic='99999999999'
 expect((await f.api.connect()).cachedBalance).toEqual(SAVED_BALANCE)
 await f.api.flushBalanceCache()
 expect(cache.counts()).toEqual({loads:1,writes:0});expect(cache.saved()).toEqual(SAVED_BALANCE)
})

test('connecting during a delayed startup read waits before replacing the saved spend-known balance',async()=>{
 const cache=balanceStore();let resolve!:(v:typeof SAVED_BALANCE)=>void
 cache.store.loadBalance=async()=>new Promise(r=>{resolve=r})
 const f=fixture(false,undefined,cache.store);f.engine.currentSeedEthAddress=CACHE_SEED
 f.status.balanceAtomic='99999999999';f.status.unlockedBalanceAtomic='99999999999'
 const startup=f.api.getStatus(),connecting=f.api.connect()
 while(f.counts().configures===0)await new Promise(r=>setTimeout(r,0))
 expect(cache.counts().writes).toBe(0)
 resolve(SAVED_BALANCE)
 expect((await startup).cachedBalance).toBeUndefined()
 expect((await connecting).cachedBalance).toEqual(SAVED_BALANCE)
 await f.api.flushBalanceCache();expect(cache.counts().writes).toBe(0)
})

test('an unreadable startup snapshot is not overwritten if secure storage later permits writes',async()=>{
 const cache=balanceStore();cache.store.loadBalance=async()=>{throw Error('locked')}
 const f=fixture(false,undefined,cache.store);f.engine.currentSeedEthAddress=CACHE_SEED
 expect((await f.api.connect()).cachedBalance).toBeUndefined()
 await f.api.flushBalanceCache();expect(cache.counts().writes).toBe(0)
 expect(cache.saved()).toEqual(SAVED_BALANCE)
})
