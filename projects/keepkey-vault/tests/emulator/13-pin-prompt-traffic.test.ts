/**
 * The engine's PIN prompt against real emulator firmware: wrong PIN, cancel,
 * wallet switch, emulator stop, app quit, host traffic during the wait, the
 * transport deadline, and PIN plus passphrase.
 *
 * KK_EMU_DYLIB=/path/to/libkkemu.dylib bun test tests/emulator/13-pin-prompt-traffic.test.ts
 *
 * The real EngineController, EmulatorTransportDelegate and hdwallet run over
 * the dylib's FFI. Only src/bun/emulator.ts is replaced: same exports, but the
 * flashes are in-memory buffers, so nothing under ~/.keepkey is read or written.
 * Public test seeds only.
 */
import {afterAll, afterEach, describe, expect, mock, setSystemTime, test} from 'bun:test'
import {dlopen, FFIType, ptr} from 'bun:ffi'
import {EventEmitter} from 'node:events'
import {existsSync} from 'node:fs'
import * as core from '@keepkey/hdwallet-core'
import * as Messages from '@keepkey/device-protocol/lib/messages_pb'

const library = process.env.KK_EMU_DYLIB
if (!library || !existsSync(library)) throw new Error('Set KK_EMU_DYLIB to the firmware library under test')
const SEED_A = 'all all all all all all all all all all all all'
const SEED_B = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ETH_A = '0x73d0385f4d8e00c5e6504c6030f47bf6212736a8'
const ETH_B = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// ── src/bun/emulator.ts, minus the keychain ──────────────────────────────
let ffi: any = null
let instance = 0
let instances = 0
let activeName = 'default'
const flashes = new Map<string, Buffer>()
const emu = {
  initEmulator(name = 'default') {
    activeName = name
    if (!flashes.has(name)) flashes.set(name, Buffer.alloc(1 << 20, 0xff))
    ffi = dlopen(library!, {
      kkemu_init: {args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32},
      kkemu_shutdown: {args: [], returns: FFIType.void},
      kkemu_start: {args: [], returns: FFIType.i32},
      kkemu_write: {args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32},
      kkemu_read: {args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32},
    })
    if (ffi.symbols.kkemu_init(ptr(flashes.get(name)!), 1 << 20) || ffi.symbols.kkemu_start()) throw new Error('kkemu init')
    instance = ++instances
    return emu.getEmulatorStatus()
  },
  stopEmulator() {
    if (ffi) { ffi.symbols.kkemu_shutdown(); ffi.close(); ffi = null }
    instance = 0
    return emu.getEmulatorStatus()
  },
  getEmulatorStatus: () => ({state: ffi ? 'running' : 'stopped', bridgeReady: !!ffi}) as any,
  getEmulatorInstance: () => instance,
  getActiveFlashName: () => activeName,
  emuWrite: (data: Uint8Array, iface: number) => !!ffi && ffi.symbols.kkemu_write(ptr(data), data.length, iface) === 0,
  emuRead(iface: number) {
    if (!ffi) return null
    const b = new Uint8Array(64)
    return ffi.symbols.kkemu_read(ptr(b), 64, iface) > 0 ? b : null
  },
  flushRingBuffers() {
    while (emu.emuRead(0)) { /* drain */ }
    while (emu.emuRead(1)) { /* drain */ }
  },
}

mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({HIDKeepKeyAdapter: {useKeyring: () => ({})}}))
mock.module('@keepkey/hdwallet-keepkey-nodewebusb', () => ({NodeWebUSBKeepKeyAdapter: {useKeyring: () => ({})}}))
mock.module('usb', () => ({usb: new EventEmitter()}))
mock.module('electrobun/bun', () => ({Utils: {paths: {userData: '/tmp/kk-pin-traffic-test-unused'}}}))
mock.module('../../src/bun/emulator', () => emu)
mock.module('../../src/bun/emulator-keychain', () => ({hasMnemonic: () => false, loadMnemonic: () => null}))

const {EngineController} = await import('../../src/bun/engine-controller')
const {EmulatorKeepKeyAdapter, writeDecision} = await import('../../src/bun/emulator-transport')

// Engine and transport log lines: the assertions read "Unknown message" and friends from here.
const logs: string[] = []
const realLog = console.log, realWarn = console.warn, realError = console.error
const capture = (real: typeof console.log) => (...args: any[]) => {
  logs.push(args.map(a => typeof a === 'string' ? a : (a?.message ?? JSON.stringify(a))).join(' '))
  if (process.env.KK_TEST_VERBOSE) real(...args)
}
console.log = capture(realLog); console.warn = capture(realWarn); console.error = capture(realError)
afterAll(() => { console.log = realLog; console.warn = realWarn; console.error = realError })

/** Boot `name` once from blank flash, load a seed through a throwaway connection, leave it locked. */
async function makeWallet(name: string, seed: string, pin: string, passphrase = false) {
  flashes.delete(name)
  emu.initEmulator(name)
  const keyring = new core.Keyring()
  const adapter = EmulatorKeepKeyAdapter.useKeyring(keyring)
  const wallet: any = await adapter.pairRawDevice(await adapter.getDevice(), true)
  wallet.transport.delegate.onButtonRequest = () => writeDecision(true)
  await wallet.loadDevice({mnemonic: seed, pin, passphrase, skipChecksum: false, label: name})
  await wallet.clearSession()
  await wallet.transport.disconnect()
  emu.stopEmulator()
}

/** DebugLinkGetState over iface 1, straight to the FFI: never through the engine's transport. */
async function pinMatrix(): Promise<string> {
  const req = new Uint8Array(64)
  req.set([0x3f, 0x23, 0x23, 0, 101, 0, 0, 0, 0])
  expect(emu.emuWrite(req, 1)).toBe(true)
  let body: Uint8Array | null = null
  let got = 0
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && (!body || got < body.length)) {
    const f = emu.emuRead(1)
    if (!f) { await sleep(3); continue }
    if (!body) {
      const len = (f[5] << 24) | (f[6] << 16) | (f[7] << 8) | f[8]
      body = new Uint8Array(len)
      const n = Math.min(len, 55); body.set(f.subarray(9, 9 + n)); got = n
    } else {
      const n = Math.min(body.length - got, 63); body.set(f.subarray(1, 1 + n), got); got += n
    }
  }
  if (!body || got < body.length) throw new Error('DebugLinkState not received')
  const matrix = Messages.DebugLinkState.deserializeBinary(body).getMatrix()
  expect(matrix.split('').sort().join('')).toBe('123456789')
  return matrix
}

async function until(predicate: () => boolean, label: string, ms = 8000) {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await sleep(5)
  if (!predicate()) throw new Error(`Timed out waiting for ${label}`)
}

/** Settles within `ms`, or reports that it is still pending. */
async function settled<T>(p: Promise<T> | null | undefined, ms: number) {
  if (!p) return {state: 'none' as const}
  return Promise.race([
    p.then(value => ({state: 'resolved' as const, value}), error => ({state: 'rejected' as const, error})),
    sleep(ms).then(() => ({state: 'pending' as const})),
  ])
}

let engine: InstanceType<typeof EngineController>
let pins: string[]
let passphrases: number
let pinErrors: Array<{code: number}>

async function connect(name: string) {
  emu.initEmulator(name)
  await engine.connectEmulator()
}

function newEngine() {
  engine = new EngineController()
  pins = []; passphrases = 0; pinErrors = []
  engine.on('pin-request', ({type}: any) => pins.push(type))
  engine.on('passphrase-request', () => passphrases++)
  engine.on('pin-error', (e: any) => pinErrors.push(e))
  logs.length = 0
}

async function enterPin(pin: string) {
  await until(() => pins.length > 0, 'PIN request')
  pins.shift()
  const matrix = await pinMatrix()
  await engine.sendPin(pin.split('').map(d => matrix.indexOf(d) + 1).join(''))
}

const state = () => engine.getDeviceState().state
const unknownMessages = () => logs.filter(l => /Unknown message|Unexpected message|hasAddressStr|Read timeout/.test(l))

afterEach(async () => {
  setSystemTime()
  try { engine?.disconnectEmulator() } catch {}
  emu.stopEmulator()
  await sleep(50)
})

afterAll(() => { for (const f of flashes.values()) f.fill(0) })

describe('PIN prompt on real emulator firmware', () => {
  test('a wrong PIN is refused, the prompt comes back, and the right PIN unlocks', async () => {
    await makeWallet('wrong', SEED_A, '1234')
    newEngine()
    await connect('wrong')
    expect(state()).toBe('needs_pin')
    await enterPin('1111')
    await until(() => pinErrors.length > 0, 'PIN verdict')
    expect(pinErrors[0].code).toBe(7)
    await enterPin('1234')
    await until(() => state() === 'ready', 'unlock')
    expect(unknownMessages()).toEqual([])
  }, 30_000)

  test('cancel mid-entry closes the wait; the request queued behind it still gets its PIN', async () => {
    await makeWallet('cancel', SEED_A, '1234')
    newEngine()
    await connect('cancel')
    await until(() => pins.length > 0, 'PIN request')
    const prompt = engine.unlockRequest
    const seed = engine.deriveSeedIdentity()
    await sleep(100)
    await engine.cancelDevicePrompt()
    expect((await settled(prompt, 2000)).state).toBe('rejected')
    pins.length = 0
    await enterPin('1234')
    expect(await seed).toBe(ETH_A)
    await until(() => state() === 'ready', 'unlock')
    expect(unknownMessages()).toEqual([])
  }, 30_000)

  test('switching wallets mid-PIN releases the old prompt and the next wallet connects cleanly', async () => {
    await makeWallet('switch-a', SEED_A, '1234')
    await makeWallet('switch-b', SEED_B, '5678')
    newEngine()
    await connect('switch-a')
    await until(() => pins.length > 0, 'wallet A PIN request')
    const prompt = engine.unlockRequest
    const staleSeed = engine.deriveSeedIdentity()
    await sleep(100)
    // index.ts emulatorSwitchWallet: window closed, engine let go, emulator stopped, next flash booted.
    const t0 = Date.now()
    engine.disconnectEmulator()
    emu.stopEmulator()
    pins.length = 0
    await connect('switch-b')
    expect(Date.now() - t0).toBeLessThan(5000)
    expect((await settled(prompt, 2000)).state).toBe('rejected')
    const stale = await settled(staleSeed, 2000)
    expect(stale.state).toBe('resolved')
    expect((stale as any).value).toBeNull()
    expect(engine.getDeviceState().label).toBe('switch-b')
    expect(state()).toBe('needs_pin')
    await enterPin('5678')
    await until(() => state() === 'ready', 'wallet B unlock')
    expect(await engine.deriveSeedIdentity()).toBe(ETH_B)
    expect(unknownMessages()).toEqual([])
  }, 30_000)

  test('stopping the emulator mid-PIN settles the pending read within a second', async () => {
    await makeWallet('stop', SEED_A, '1234')
    newEngine()
    await connect('stop')
    await until(() => pins.length > 0, 'PIN request')
    const prompt = engine.unlockRequest
    engine.disconnectEmulator()
    emu.stopEmulator()
    expect((await settled(prompt, 1000)).state).toBe('rejected')
    // The same wallet comes back and unlocks.
    pins.length = 0
    await connect('stop')
    await enterPin('1234')
    await until(() => state() === 'ready', 'unlock after restart')
    expect(unknownMessages()).toEqual([])
  }, 30_000)

  test('app quit (emulator stopped without disconnecting the engine) settles the pending read', async () => {
    await makeWallet('quit', SEED_A, '1234')
    newEngine()
    await connect('quit')
    await until(() => pins.length > 0, 'PIN request')
    const prompt = engine.unlockRequest
    emu.stopEmulator() // cleanupAndQuit: stopEmulator(), no disconnectEmulator()
    expect((await settled(prompt, 1000)).state).toBe('rejected')
  }, 30_000)

  test('a seed request queued behind an unanswered PIN never lands in the PIN wait', async () => {
    await makeWallet('queued', SEED_A, '1234')
    newEngine()
    await connect('queued')
    await until(() => pins.length > 0, 'PIN request')
    const prompt = engine.unlockRequest
    const seed = engine.deriveSeedIdentity()
    // The user is away for four minutes (Dev log: 240000ms emu-transport read timeout).
    setSystemTime(new Date(Date.now() + 241_000))
    await sleep(500)
    setSystemTime()
    expect((await settled(prompt, 10)).state).toBe('pending')
    expect(unknownMessages()).toEqual([])
    await enterPin('1234')
    expect(await seed).toBe(ETH_A)
    await until(() => state() === 'ready', 'unlock')
    expect(unknownMessages()).toEqual([])
  }, 30_000)

  test('a message that bypasses the transport lock is refused while the PIN wait is open', async () => {
    await makeWallet('bypass', SEED_A, '1234')
    newEngine()
    await connect('bypass')
    await until(() => pins.length > 0, 'PIN request')
    const prompt = engine.unlockRequest
    const err = await (engine.wallet as any).transport.call(
      Messages.MessageType.MESSAGETYPE_GETFEATURES, new Messages.GetFeatures(), {omitLock: true}).then(() => null, (e: any) => e)
    expect(err?.status).toBe(423)
    expect((await settled(prompt, 300)).state).toBe('pending')
    await enterPin('1234')
    await until(() => state() === 'ready', 'unlock')
    expect(unknownMessages()).toEqual([])
  }, 30_000)

  test('a PIN prompt past the transport deadline reconnects and prompts again', async () => {
    await makeWallet('deadline', SEED_A, '1234')
    newEngine()
    await connect('deadline')
    await until(() => pins.length > 0, 'first PIN request')
    pins.length = 0
    // hdwallet's own deadline, shortened for this connection: 1.5 s instead of 5 minutes.
    const transport = (engine.wallet as any).transport
    const withDeadline = transport.withDeadline.bind(transport)
    transport.withDeadline = (action: any, ms: number, op: string) =>
      withDeadline(action, ms === core.LONG_TIMEOUT ? 1500 : ms, op)
    // Release the current wait so the re-prompt is the one under the short deadline.
    const prompt = engine.unlockRequest
    await engine.cancelDevicePrompt()
    await settled(prompt, 2000)
    await until(() => pins.length > 0, 'PIN request under the short deadline')
    pins.length = 0
    await until(() => pins.length > 0, 'PIN request after the deadline', 15_000)
    expect((engine.wallet as any).transport).not.toBe(transport)
    await enterPin('1234')
    await until(() => state() === 'ready', 'unlock')
    expect(unknownMessages()).toEqual([])
  }, 40_000)

  test('a stale passphrase sent during the PIN wait is refused, and the PIN still lands', async () => {
    await makeWallet('cross-ack', SEED_A, '1234')
    newEngine()
    await connect('cross-ack')
    await until(() => pins.length > 0, 'PIN request')
    // The engine refuses it as unasked; sent past the engine (REST's direct wallet call), the guard refuses it.
    expect((await engine.sendPassphrase('').then(() => null, (e: any) => e))?.status).toBe(409)
    expect((await (engine.wallet as any).sendPassphrase('').then(() => null, (e: any) => e))?.status).toBe(423)
    await enterPin('1234')
    await until(() => state() === 'ready', 'unlock')
    expect(unknownMessages()).toEqual([])
  }, 30_000)

  test("a new connection's Initialize ends a PIN wait the old connection abandoned", async () => {
    await makeWallet('reinit', SEED_A, '1234')
    newEngine()
    await connect('reinit')
    await until(() => pins.length > 0, 'PIN request')
    const prompt = engine.unlockRequest
    await (engine.wallet as any).transport.delegate.disconnect() // the firmware still waits for its PIN
    expect((await settled(prompt, 1000)).state).toBe('rejected')
    pins.length = 0
    await engine.connectEmulator() // same emulator boot: Initialize lands in that wait
    expect(state()).toBe('needs_pin')
    await enterPin('1234')
    await until(() => state() === 'ready', 'unlock')
    expect(emu.emuRead(0)).toBeNull() // no reply left over for the next request
    expect(unknownMessages()).toEqual([])
  }, 30_000)

  test('the wrong-PIN countdown is waited out with the pad disabled, not timed out into an error', async () => {
    await makeWallet('countdown', SEED_A, '1234')
    newEngine()
    const states: string[] = []
    engine.on('state-change', (s: any) => states.push(s.state))
    await connect('countdown')
    for (let i = 0; i < 3; i++) {
      await enterPin('1111')
      await until(() => pinErrors.length === i + 1, `wrong PIN ${i + 1}`)
    }
    // Three failures: the next request counts down 8 s before its PinMatrixRequest. Give this
    // connection a 1.5 s LONG_TIMEOUT so a deadline on the countdown would fire well inside it.
    const transport = (engine.wallet as any).transport
    const withDeadline = transport.withDeadline.bind(transport)
    transport.withDeadline = (action: any, ms: number, op: string) => withDeadline(action, ms === core.LONG_TIMEOUT ? 1500 : ms, op)
    engine.once('pin-request', () => { transport.withDeadline = withDeadline }) // the PIN wait itself keeps its deadline
    await sleep(3000 + 4000) // the 3 s re-prompt, then half the countdown
    expect(state()).toBe('needs_pin')
    expect(engine.getDeviceState().pinPromptOpen).toBe(false) // PinEntry shows the pad disabled
    await until(() => pins.length > 0, 'PIN request after the countdown', 15_000)
    await enterPin('1234')
    await until(() => state() === 'ready', 'unlock')
    expect(states).not.toContain('error')
    expect(unknownMessages()).toEqual([])
  }, 60_000)

  test('a PIN prompt left unanswered reconnects once, then tells the user instead of re-prompting forever', async () => {
    await makeWallet('idle', SEED_A, '1234')
    newEngine()
    // Every connection's PIN wait gets a 1.5 s deadline instead of 5 minutes.
    engine.on('pin-request', () => {
      const transport = (engine.wallet as any).transport
      if (transport.shortDeadline) return
      transport.shortDeadline = true
      const withDeadline = transport.withDeadline.bind(transport)
      transport.withDeadline = (action: any, ms: number, op: string) => withDeadline(action, ms === core.LONG_TIMEOUT ? 1500 : ms, op)
    })
    await connect('idle')
    await until(() => state() === 'error', 'the second timeout', 15_000)
    const {EMULATOR_UNLOCK_TIMEOUT_MESSAGE} = await import('../../src/bun/pin-unlock')
    expect(engine.getDeviceState().error).toBe(EMULATOR_UNLOCK_TIMEOUT_MESSAGE)
    const prompts = pins.length
    expect(prompts).toBe(2)
    await sleep(4000)
    expect(pins.length).toBe(prompts)
  }, 40_000)

  test('PIN plus passphrase: a message during the passphrase wait is refused and the wallet unlocks', async () => {
    await makeWallet('passphrase', SEED_A, '1234', true)
    newEngine()
    await connect('passphrase')
    await enterPin('1234')
    await until(() => passphrases > 0, 'passphrase request')
    const err = await (engine.wallet as any).transport.call(
      Messages.MessageType.MESSAGETYPE_GETFEATURES, new Messages.GetFeatures(), {omitLock: true}).then(() => null, (e: any) => e)
    expect(err?.status).toBe(423)
    // 7.17 shows the passphrase for a press: the user presses the emulator's button.
    ;(engine.wallet as any).transport.delegate.onButtonRequest = () => writeDecision(true)
    await engine.sendPassphrase('')
    await until(() => state() === 'ready', 'unlock')
    expect(await engine.deriveSeedIdentity()).toBe(ETH_A)
    expect(unknownMessages()).toEqual([])
  }, 30_000)
})
