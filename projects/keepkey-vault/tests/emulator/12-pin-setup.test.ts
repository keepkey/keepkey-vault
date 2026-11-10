/**
 * Real firmware PIN ceremonies through EngineController's emulator setup gate.
 * Anonymous flash and public test seed only; no USB or saved emulator wallets.
 *
 * KK_EMU_DYLIB=/path/to/libkkemu.dylib bun test tests/emulator/12-pin-setup.test.ts
 *
 * The window adapter is the sole stand-in: each real ButtonRequest is HELD
 * until this test explicitly chooses Yes/No, as a click on the emulator would.
 */
import {afterAll, beforeAll, describe, expect, mock, test} from 'bun:test'
import {dlopen, FFIType, ptr} from 'bun:ffi'
import {EventEmitter} from 'node:events'
import {existsSync} from 'node:fs'
import * as core from '@keepkey/hdwallet-core'
import {Transport, create, type TransportDelegate} from '@keepkey/hdwallet-keepkey'
import * as Messages from '@keepkey/device-protocol/lib/messages_pb'

const library = process.env.KK_EMU_DYLIB
if (!library || !existsSync(library)) throw new Error('Set KK_EMU_DYLIB to the firmware library under test')
const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const buttons: Array<{operation: string; decide: (yes: boolean) => void}> = []
const pins: string[] = []
const gateCalls: string[] = []

mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({HIDKeepKeyAdapter: {useKeyring: () => ({})}}))
mock.module('@keepkey/hdwallet-keepkey-nodewebusb', () => ({NodeWebUSBKeepKeyAdapter: {useKeyring: () => ({})}}))
mock.module('usb', () => ({usb: new EventEmitter()}))
mock.module('electrobun/bun', () => ({Utils: {paths: {userData: '/tmp/kk-pin-test-unused'}}}))
// This fixture owns its anonymous FFI flash directly. A fallback through the
// saved-emulator adapter must fail here instead of consulting the user's home.
mock.module('../../src/bun/emulator', () => ({
  getActiveFlashName: () => 'isolated-pin-regression',
  getEmulatorStatus: () => ({state: 'running', bridgeReady: true}),
  getEmulatorInstance: () => 1,
  flushRingBuffers() {},
  emuRead: () => { throw new Error('Unexpected saved-emulator access in anonymous PIN setup fixture') },
  emuWrite: () => { throw new Error('Unexpected saved-emulator access in anonymous PIN setup fixture') },
}))
mock.module('../../src/bun/emulator-keychain', () => ({hasMnemonic: () => false, loadMnemonic: () => null}))
mock.module('../../src/bun/emulator-window', () => ({
  emuInteractiveConfirm: async (fn: () => Promise<unknown>, details: {operation: string}, delegate: Delegate) => {
    gateCalls.push(details.operation)
    const previous = delegate.onButtonRequest
    delegate.onButtonRequest = () => buttons.push({operation: details.operation, decide: writeDecision})
    try { return await fn() } finally { delegate.onButtonRequest = previous }
  },
}))

const {EngineController} = await import('../../src/bun/engine-controller')
let ffi: ReturnType<typeof openLibrary>
let flash: Buffer
let wallet: any
let engine: InstanceType<typeof EngineController>
let delegate: Delegate

function openLibrary() {
  return dlopen(library!, {
    kkemu_init: {args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32},
    kkemu_shutdown: {args: [], returns: FFIType.void},
    kkemu_start: {args: [], returns: FFIType.i32},
    kkemu_stop: {args: [], returns: FFIType.void},
    kkemu_write: {args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32},
    kkemu_read: {args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32},
    kkemu_pop_frame: {args: [FFIType.ptr], returns: FFIType.i32},
    get_pin_font: {args: [], returns: FFIType.ptr},
    draw_char: {args: [FFIType.ptr, FFIType.ptr, FFIType.i8, FFIType.ptr], returns: FFIType.void},
  })
}

function writeDecision(yes: boolean) {
  const frame = new Uint8Array(64)
  frame.set([0x3f, 0x23, 0x23, 0, 100, 0, 0, 0, 2, 8, yes ? 1 : 0])
  expect(ffi.symbols.kkemu_write(ptr(frame), frame.length, 1)).toBe(0)
}

class Delegate implements TransportDelegate {
  onButtonRequest: (() => void) | null = null
  async isOpened() { return true }
  async getDeviceID() { return 'isolated-pin-regression' }
  async connect() {}
  async disconnect() {}
  async tryConnectDebugLink() { return true }
  async writeChunk(bytes: Uint8Array, debug?: boolean) {
    if (ffi.symbols.kkemu_write(ptr(bytes), bytes.length, debug ? 1 : 0)) throw new Error('Emulator write failed')
  }
  async readChunk(debug?: boolean) {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const frame = new Uint8Array(64)
      if (ffi.symbols.kkemu_read(ptr(frame), frame.length, debug ? 1 : 0) > 0) {
        if (!debug && frame[0] === 0x3f && frame[1] === 0x23 && frame[2] === 0x23 && frame[3] === 0 && frame[4] === 26) {
          this.onButtonRequest?.()
        }
        return frame
      }
      await sleep(3)
    }
    throw new Error('PIN regression emulator read timed out')
  }
}

async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 5000
  while (!predicate() && Date.now() < deadline) await sleep(3)
  if (!predicate()) throw new Error(`Waiting for ${label}`)
}

async function choose(yes: boolean, operation = 'changePin') {
  await until(() => buttons.length > 0, 'visible emulator confirmation')
  const button = buttons.shift()!
  expect(button.operation).toBe(operation)
  button.decide(yes)
}

async function enterPin(actual: string, type: string) {
  await until(() => pins.length > 0, `PIN matrix ${type}`)
  expect(pins.shift()).toBe(type)
  const state = await wallet.transport.call(Messages.MessageType.MESSAGETYPE_DEBUGLINKGETSTATE,
    new Messages.DebugLinkGetState(), {debugLink: true, omitLock: true})
  const matrix = state.message.matrix as string
  expect(matrix.split('').sort().join('')).toBe('123456789')
  const positions = actual.split('').map(n => matrix.indexOf(n) + 1).join('')
  await engine.sendPin(positions)
}

async function assertPinDigitsVisible() {
  // Inspect only the independent DebugLink. Transport.call() clears its shared
  // userActionRequired flag on completion, which would make wallet.cancel()
  // incorrectly believe the main-interface PIN request had already finished.
  const debugRequest = new Uint8Array(64)
  debugRequest.set([0x3f, 0x23, 0x23, 0, 101, 0, 0, 0, 0])
  await delegate.writeChunk(debugRequest, true)
  const state = await wallet.transport.readResponse(true, 5000)
  // Only this test's anonymous firmware flash is read. Never inspect a user's
  // wallet or copy the matrix into Desktop's UI. It stays an OLED-only input.
  const matrix = state.message.matrix as string
  expect(matrix.split('').sort().join('')).toBe('123456789')
  const expected = Buffer.alloc(256 * 64, 0x11)
  // C Canvas: buffer pointer, uint16 height/width, bool dirty. Draw into an
  // independent canvas using the firmware's actual PIN font, not its live
  // canvas. Both macOS arm64/x64 layouts have an eight-byte pointer.
  const canvas = Buffer.alloc(16)
  canvas.writeBigUInt64LE(BigInt(ptr(expected)), 0)
  canvas.writeUInt16LE(64, 8)
  canvas.writeUInt16LE(256, 10)
  const regions: Array<{x: number; y: number; width: number}> = []
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const digit = matrix[col + (2 - row) * 3]
      const x = 200 + col * 19 + (digit === '1' ? 1 : 0)
      const y = 8 + row * 19
      const params = Buffer.alloc(6)
      params[0] = 255
      params.writeUInt16LE(x, 2)
      params.writeUInt16LE(y, 4)
      ffi.symbols.draw_char(ptr(canvas), ffi.symbols.get_pin_font(), digit.charCodeAt(0), ptr(params))
      regions.push({x, y, width: digit === '1' ? 4 : 8})
    }
  }
  const threshold = [[0,128,32,160],[192,64,224,96],[48,176,16,144],[240,112,208,80]]
  const frame = new Uint8Array(2048)
  let matches = false
  let best = 0
  const deadline = performance.now() + 2500
  while (!matches && performance.now() < deadline) {
    for (let drained = 0; drained < 64 && ffi.symbols.kkemu_pop_frame(ptr(frame)); drained++) {
      const matching = regions.filter(({x,y,width}) => {
        for (let yy = y; yy < y + 12; yy++) {
          for (let xx = x; xx < x + width; xx++) {
            const lit = expected[yy * 256 + xx] > threshold[yy & 3][xx & 3]
            if (!!(frame[(yy >> 3) * 256 + xx] & (1 << (yy & 7))) !== lit) return false
          }
        }
        return true
      }).length
      best = Math.max(best, matching)
      matches = matching === 9
      if (matches) break
    }
    if (!matches) await sleep(20)
  }
  console.log('  OLED regression: visible matching digit cells', best)
  expect(matches).toBe(true)
}

function run(operation: () => Promise<unknown>) {
  let done = false
  const settled = operation().then(value => ({ok: true, value}), error => ({ok: false, error}))
    .finally(() => { done = true })
  return {settled, done: () => done}
}

async function finish(op: ReturnType<typeof run>, operation = 'changePin') {
  const deadline = Date.now() + 5000
  while (!op.done() && Date.now() < deadline) {
    if (buttons.length) await choose(true, operation)
    await sleep(3)
  }
  await until(op.done, 'PIN ceremony result')
  return op.settled
}

beforeAll(async () => {
  ffi = openLibrary()
  flash = Buffer.alloc(1 << 20, 0xff)
  expect(ffi.symbols.kkemu_init(ptr(flash), flash.length)).toBe(0)
  expect(ffi.symbols.kkemu_start()).toBe(0)
  delegate = new Delegate()
  const keyring = new core.Keyring()
  const transport = await Transport.create(keyring, delegate)
  await transport.connect()
  await transport.tryConnectDebugLink()
  wallet = create(transport)
  delegate.onButtonRequest = () => writeDecision(true)
  await wallet.loadDevice({mnemonic: seed, pin: false, passphrase: false, skipChecksum: false})
  delegate.onButtonRequest = null
  engine = new EngineController()
  Object.assign(engine, {wallet, activeTransport: 'emulator', cachedFeatures: await wallet.getFeatures()})
  ;(engine as any).attachTransportListeners()
  engine.on('pin-request', ({type}) => pins.push(type))
})

afterAll(() => {
  try { ffi?.symbols.kkemu_stop() } catch {}
  try { ffi?.symbols.kkemu_shutdown() } catch {}
  try { ffi?.close() } catch {}
  flash?.fill(0)
})

describe('PIN setup on real emulator firmware', () => {
  test('declining Create PIN releases the request and keeps the existing seed', async () => {
    const op = run(() => engine.changePin())
    await choose(false)
    expect((await finish(op)).ok).toBe(false)
    expect((await wallet.getFeatures()).initialized).toBe(true)
    expect((await wallet.getFeatures()).pinProtection).toBe(false)
    expect(delegate.onButtonRequest).toBeNull()
  })

  test('mismatched new PIN entries fail without installing a PIN', async () => {
    const op = run(() => engine.changePin())
    await choose(true)
    await enterPin('1234', 'new-first')
    await enterPin('5678', 'new-second')
    expect((await finish(op)).ok).toBe(false)
    expect((await wallet.getFeatures()).pinProtection).toBe(false)
  })

  test('setting a PIN completes after both scrambled matrices', async () => {
    const op = run(() => engine.changePin())
    await choose(true)
    await enterPin('1234', 'new-first')
    await enterPin('1234', 'new-second')
    expect((await finish(op)).ok).toBe(true)
    expect((await wallet.getFeatures()).pinProtection).toBe(true)
  })

  test('changing an existing PIN labels current, new-first and new-second correctly', async () => {
    const op = run(() => engine.changePin())
    await choose(true)
    await enterPin('1234', 'current')
    await enterPin('5678', 'new-first')
    await enterPin('5678', 'new-second')
    expect((await finish(op)).ok).toBe(true)
    expect((await wallet.getFeatures()).pinProtection).toBe(true)
  })

  test('removing a PIN holds its confirmation and accepts the current PIN', async () => {
    const op = run(() => engine.removePin())
    await choose(true, 'removePin')
    await enterPin('5678', 'current')
    expect((await finish(op, 'removePin')).ok).toBe(true)
    expect((await wallet.getFeatures()).pinProtection).toBe(false)
    expect(delegate.onButtonRequest).toBeNull()
    expect(gateCalls).toEqual(['changePin', 'changePin', 'changePin', 'changePin', 'removePin'])
  })

  test('all nine PIN digits appear while waiting, then cancellation leaves a usable wallet', async () => {
    const op = run(() => engine.changePin())
    await choose(true)
    await until(() => pins.length > 0, 'first PIN matrix before cancellation')
    expect(pins.shift()).toBe('new-first')
    await assertPinDigitsVisible()
    await wallet.cancel()
    expect((await finish(op)).ok).toBe(false)
    expect(delegate.onButtonRequest).toBeNull()
    // The PIN handler and its outer ChangePin handler must not each emit a
    // terminal Failure: a second one would poison the next request's reply.
    await sleep(20)
    const stale = new Uint8Array(64)
    expect(ffi.symbols.kkemu_read(ptr(stale), stale.length, 0)).toBe(0)
    const features = await wallet.getFeatures()
    expect(features.initialized).toBe(true)
    expect(features.pinProtection).toBe(false)
    expect(gateCalls).toEqual(['changePin', 'changePin', 'changePin', 'changePin', 'removePin', 'changePin'])
  })
})
