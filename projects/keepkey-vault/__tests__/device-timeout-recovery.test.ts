/**
 * A KeepKey request that times out must not leave the Vault on a dead connection.
 *
 * vault-backend.log, 2026-11-18 (fw 7.16.0, Vault 1.7.0 dev): at 18:06:45 and again
 * at 18:32:40 one request outlived hdwallet's 5000 ms deadline. hdwallet quarantined
 * the transport, so every later call failed at once with the same error: "[Engine]
 * seed fingerprint (eth) failed" and "[wallet-watch] Refresh failed" 156 times in
 * 15 minutes, REST /addresses/eth and /addresses/hive too, while the engine still
 * said "ready". Only a replug opened a new connection.
 *
 * The device here is scripted. Its USB pipe outlives a connection, as a real
 * endpoint does: a reply to a request that timed out is still there for the next
 * handle. hdwallet's Transport and the engine are real.
 *
 * Run: bun test __tests__/device-timeout-recovery.test.ts
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import * as core from '@keepkey/hdwallet-core'
import * as Messages from '@keepkey/device-protocol/lib/messages_pb'
import { Transport, create, type TransportDelegate } from '@keepkey/hdwallet-keepkey'

const T = Messages.MessageType
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function frame(type: number, body: Uint8Array = new Uint8Array()): Uint8Array {
  const f = new Uint8Array(64)
  f.set([0x3f, 0x23, 0x23, type >> 8, type & 255, 0, 0, 0, body.length])
  f.set(body, 9)
  return f
}
const failure = (code: number, message: string) => {
  const m = new Messages.Failure(); m.setCode(code); m.setMessage(message)
  return frame(T.MESSAGETYPE_FAILURE, m.serializeBinary())
}
const features = () => {
  const m = new Messages.Features(); m.setMajorVersion(7); m.setMinorVersion(16); m.setPatchVersion(0)
  m.setInitialized(true); m.setPinProtection(true); m.setPinCached(true); m.setDeviceId('SCRIPTED'); m.setLabel('scripted')
  return frame(T.MESSAGETYPE_FEATURES, m.serializeBinary())
}
const publicKey = () => { const m = new Messages.PublicKey(); m.setXpub('xpub-scripted'); return frame(T.MESSAGETYPE_PUBLICKEY, m.serializeBinary()) }
const success = (message = '') => { const m = new Messages.Success(); m.setMessage(message); return frame(T.MESSAGETYPE_SUCCESS, m.serializeBinary()) }

/** The device and its USB pipe. Replies queue in `out` whichever handle is open. */
class ScriptedKeepKey {
  out: Uint8Array[] = []
  received: number[] = []
  /** The next GetPublicKey gets no reply until release(): the device went quiet. */
  hangNext = false
  /** Every request goes unanswered. */
  silent = false
  wait: 'button' | null = null
  private late: Uint8Array | null = null
  release() { if (this.late) { this.out.push(this.late); this.late = null } }
  handle(type: number, body: Uint8Array) {
    this.received.push(type)
    if (this.silent) return
    if (this.wait === 'button') {
      if (type === T.MESSAGETYPE_CANCEL) { this.wait = null; this.out.push(failure(4, 'Action cancelled by user')) }
      else this.out.push(failure(1, 'Unexpected message'))
      return
    }
    if (type === T.MESSAGETYPE_GETPUBLICKEY) {
      if (this.hangNext) { this.hangNext = false; this.late = publicKey(); return }
      this.out.push(publicKey())
    } else if (type === T.MESSAGETYPE_INITIALIZE || type === T.MESSAGETYPE_GETFEATURES) {
      this.out.push(features())
    } else if (type === T.MESSAGETYPE_PING) {
      this.out.push(success(Messages.Ping.deserializeBinary(body).getMessage()))
    } else if (type === T.MESSAGETYPE_CANCEL) {
      this.out.push(failure(4, 'Action cancelled'))
    } else {
      this.out.push(failure(1, 'Unknown message'))
    }
  }
  connection() { return new Connection(this) }
}

/** One USB handle on the device: closing it ends its pending read, not the device's queue. */
class Connection implements TransportDelegate {
  open = false
  constructor(readonly device: ScriptedKeepKey) {}
  async isOpened() { return this.open }
  async getDeviceID() { return 'SCRIPTED' }
  async connect() { if (this.open) throw new Error('cannot connect an already-connected connection'); this.open = true }
  async disconnect() { this.open = false }
  async writeChunk(buf: Uint8Array) {
    if (!this.open) throw new Error('scripted handle closed')
    const length = (buf[5] << 24) | (buf[6] << 16) | (buf[7] << 8) | buf[8]
    this.device.handle((buf[3] << 8) | buf[4], buf.slice(9, 9 + length))
  }
  async readChunk(): Promise<Uint8Array> {
    for (;;) {
      if (!this.open) throw new Error('scripted handle closed')
      const next = this.device.out.shift()
      if (next) return next
      await sleep(2)
    }
  }
}

// The engine's adapters, pointed at whichever scripted device the test plugs in.
const plugged: { device: ScriptedKeepKey | null } = { device: null }
const usbDevice = { opened: false, async close() {}, async reset() {} }
const webUsbAdapter = {
  async getDevice() { if (!plugged.device) throw new Error('no device'); return usbDevice },
  async getTransportDelegate() { return plugged.device!.connection() },
  async pairRawDevice() {
    const transport = await Transport.create(new core.Keyring(), plugged.device!.connection())
    await transport.connect()
    const wallet = create(transport)
    await wallet.initialize()
    return wallet
  },
}
mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: { useKeyring: () => ({ getDevice: async () => { throw new Error('no HID device') } }) } }))
mock.module('@keepkey/hdwallet-keepkey-nodewebusb', () => ({ NodeWebUSBKeepKeyAdapter: { useKeyring: () => webUsbAdapter } }))
mock.module('usb', () => ({ usb: Object.assign(new EventEmitter(), { getDeviceList: () => [] }) }))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData: '/tmp/kk-device-timeout-unused' } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData: '/tmp/kk-device-timeout-unused' } }))

const { EngineController, DEVICE_UNRESPONSIVE_MESSAGE } = await import('../src/bun/engine-controller')
const { createReconnectBudget, resyncKeepKey, watchTransportTimeouts } = await import('../src/bun/device-timeout')

const gpk = () => {
  const m = new Messages.GetPublicKey(); m.setAddressNList([0x8000002c, 0x80000000, 0x80000000]); m.setCoinName('Bitcoin')
  return m
}
const getPublicKey = (transport: any, msgTimeout = 40) =>
  transport.call(T.MESSAGETYPE_GETPUBLICKEY, gpk(), { msgTimeout }).then((event: any) => event, (error: any) => error)
async function until(predicate: () => boolean, label: string, ms = 3000) {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await sleep(5)
  if (!predicate()) throw new Error(`Timed out waiting for ${label}`)
}

const engines: any[] = []
afterEach(() => {
  for (const engine of engines.splice(0)) { engine.clearRetry(); engine.stopDiscoveryPoll?.() }
  plugged.device = null
})

/** A Vault paired with the scripted KeepKey and ready, as before the hang. */
async function readyEngine(device: ScriptedKeepKey) {
  plugged.device = device
  const transport = await Transport.create(new core.Keyring(), device.connection())
  await transport.connect()
  const wallet = create(transport)
  const engine: any = new EngineController()
  engines.push(engine)
  Object.assign(engine, { wallet, activeTransport: 'webusb', cachedFeatures: { initialized: true, pinProtection: true, pinCached: true }, lastState: 'ready' })
  engine.timeoutReconnectDelayMs = 30
  engine.attachTransportListeners()
  return { engine, wallet: wallet as any, transport: transport as any }
}

describe('a KeepKey request that times out', () => {
  test('retires the dead connection at once: no longer ready, so background readers stop asking it', async () => {
    const device = new ScriptedKeepKey()
    const { engine, transport } = await readyEngine(device)
    engine.timeoutReconnectDelayMs = 60_000 // look before the reopen
    device.hangNext = true
    const stuck = getPublicKey(transport)
    const queued = [getPublicKey(transport), getPublicKey(transport), getPublicKey(transport)]
    expect((await stuck)?.name).toBe('TransportTimeoutError')
    for (const error of await Promise.all(queued)) expect(error?.name).toBe('TransportTimeoutError')

    // develop: still 'ready' on the quarantined transport, so wallet watch keeps refreshing
    // (canWatch is state === 'ready') and every refresh fails instantly.
    expect(engine.getDeviceState().state).toBe('connected_unpaired')
    expect(engine.wallet).toBeNull()
    const writes = device.received.length
    expect(await engine.deriveSeedFingerprint()).toBeNull()
    expect(device.received.length).toBe(writes) // the fingerprint never touched the device
  })

  test('reports the timeout once, naming the request that went unanswered', async () => {
    const device = new ScriptedKeepKey()
    const { engine, transport } = await readyEngine(device)
    engine.timeoutReconnectDelayMs = 60_000
    const warn = mock(() => {})
    const original = console.warn
    console.warn = warn as any
    try {
      device.hangNext = true
      await Promise.all([getPublicKey(transport), getPublicKey(transport), getPublicKey(transport)])
    } finally { console.warn = original }
    const lines = warn.mock.calls.map(args => String(args[0])).filter(line => line.includes('stopped answering'))
    expect(lines).toEqual([expect.stringContaining('last request sent: GETPUBLICKEY')])
  })

  test('reopens the KeepKey on its own, draining the late reply first, and every reply after matches its request', async () => {
    const device = new ScriptedKeepKey()
    const { engine, transport } = await readyEngine(device)
    device.hangNext = true
    expect((await getPublicKey(transport))?.name).toBe('TransportTimeoutError')
    device.release() // the device finally answers the request that timed out
    expect(device.out.length).toBe(1)

    await until(() => engine.getDeviceState().state === 'ready' && !!engine.wallet, 'automatic reconnect')
    const fresh = engine.wallet.transport
    expect(fresh).not.toBe(transport)
    expect(device.received.slice(1, 3)).toEqual([T.MESSAGETYPE_PING, T.MESSAGETYPE_INITIALIZE])
    expect(device.out).toEqual([])
    // In step: each request gets its own reply, not the one before it.
    expect((await fresh.call(T.MESSAGETYPE_GETFEATURES, new Messages.GetFeatures())).message_enum).toBe(T.MESSAGETYPE_FEATURES)
    expect((await getPublicKey(fresh, 1000)).message_enum).toBe(T.MESSAGETYPE_PUBLICKEY)
  })

  test('without the drain, a reconnect reads the late reply as its Features (what the resync prevents)', async () => {
    const device = new ScriptedKeepKey()
    device.out.push(publicKey()) // a late reply left by a timed-out connection
    const transport = await Transport.create(new core.Keyring(), device.connection())
    await transport.connect()
    await expect(create(transport).initialize()).rejects.toThrow()
    // The real Features is now the next reply: one behind for the rest of the session.
    expect(device.out.map(f => (f[3] << 8) | f[4])).toEqual([T.MESSAGETYPE_FEATURES])
  })

  test('a KeepKey that keeps timing out is reopened a bounded number of times, then waits for a replug', async () => {
    const device = new ScriptedKeepKey()
    const { engine } = await readyEngine(device)
    engine.timeoutReconnectDelayMs = 60_000
    const states: string[] = []
    for (let i = 0; i < 4; i++) {
      const transport = await Transport.create(new core.Keyring(), device.connection())
      await transport.connect()
      Object.assign(engine, { wallet: create(transport), lastState: 'ready' })
      engine.attachTransportListeners()
      device.hangNext = true
      expect((await getPublicKey(transport))?.name).toBe('TransportTimeoutError')
      states.push(engine.getDeviceState().state)
    }
    expect(states).toEqual(['connected_unpaired', 'connected_unpaired', 'connected_unpaired', 'error'])
    expect(engine.getDeviceState().error ?? engine.lastError).toBe(DEVICE_UNRESPONSIVE_MESSAGE)
    expect(engine.retryTimer).toBeNull() // nothing scheduled: no retry storm against a stuck device
  })

  test('the emulator keeps its own timeout handling', async () => {
    const device = new ScriptedKeepKey()
    const { engine, transport } = await readyEngine(device)
    engine.activeTransport = 'emulator'
    device.hangNext = true
    expect((await getPublicKey(transport))?.name).toBe('TransportTimeoutError')
    expect(engine.wallet?.transport).toBe(transport)
    expect(engine.retryTimer).toBeNull()
  })
})

describe('resyncKeepKey', () => {
  const open = async (device: ScriptedKeepKey) => { const c = device.connection(); await c.connect(); return c }

  test('an in-step device answers the Ping directly', async () => {
    const device = new ScriptedKeepKey()
    expect(await resyncKeepKey(await open(device))).toBe(0)
    expect(device.received).toEqual([T.MESSAGETYPE_PING])
  })

  test('a device left in a prompt is cancelled and pinged again', async () => {
    const device = new ScriptedKeepKey()
    device.wait = 'button'
    device.out.push(frame(T.MESSAGETYPE_BUTTONREQUEST)) // late prompt from the timed-out request
    const discarded = await resyncKeepKey(await open(device))
    expect(device.received).toEqual([T.MESSAGETYPE_PING, T.MESSAGETYPE_CANCEL, T.MESSAGETYPE_PING])
    expect(discarded).toBe(3) // ButtonRequest, the first Ping refused in the prompt, the Cancel's Failure
    expect(device.out).toEqual([])
  })

  test('a silent device fails within the deadline and its handle is closed', async () => {
    const device = new ScriptedKeepKey()
    device.silent = true
    const connection = await open(device)
    const started = Date.now()
    await expect(resyncKeepKey(connection, { timeoutMs: 50 })).rejects.toThrow('did not answer within 50ms')
    expect(Date.now() - started).toBeLessThan(1000)
    expect(connection.open).toBe(false)
  })
})

describe('watchTransportTimeouts / createReconnectBudget', () => {
  test('ordinary device errors are not timeouts', async () => {
    const device = new ScriptedKeepKey()
    const transport: any = await Transport.create(new core.Keyring(), device.connection())
    await transport.connect()
    const seen: unknown[] = []
    watchTransportTimeouts(transport, info => seen.push(info))
    const refused = await transport.call(T.MESSAGETYPE_WIPEDEVICE, new Messages.WipeDevice()).catch((e: any) => e)
    expect(refused?.message?.message).toBe('Unknown message')
    expect(seen).toEqual([])
  })

  test('the budget refills as old reconnects leave the window', () => {
    let now = 0
    const budget = createReconnectBudget({ max: 2, windowMs: 1000, now: () => now })
    expect([budget.take(), budget.take(), budget.take()]).toEqual([true, true, false])
    now = 1500
    expect(budget.take()).toBe(true)
    budget.reset()
    expect([budget.take(), budget.take()]).toEqual([true, true])
  })
})
