/**
 * Nothing but the answer reaches a KeepKey waiting for its PIN or passphrase.
 *
 * What firmware does with anything else in that wait (raw wire, 2026-11-06):
 *  - 7.17 (alpha + #1042/#1043 dylib): Failure 1 and the wait ENDS. A correct
 *    PinMatrixAck sent next gets "Unexpected message": the PIN is lost.
 *  - 7.16 (dylib): non-tiny messages get Failure 1 "Unknown message" and the wait
 *    CONTINUES; another wait's ack is ignored (pin_sm.c default: break). The
 *    request reading the wait takes that Failure as its reply while the device
 *    still waits.
 * Dev log 2026-11-06: an unlock request queued behind a seed-fingerprint
 * request that was waiting on the PIN landed in that wait every 240 s.
 *
 * The device here is scripted to behave like either firmware; hdwallet's
 * Transport and the engine are real. activeTransport is a hardware one unless
 * a test says otherwise: the guard and the PIN Cancel apply to USB/HID too.
 *
 * Run: bun test __tests__/pin-wait-guard.test.ts
 */
import { describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import * as core from '@keepkey/hdwallet-core'
import * as Messages from '@keepkey/device-protocol/lib/messages_pb'
import { Transport, create, type TransportDelegate } from '@keepkey/hdwallet-keepkey'

mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: { useKeyring: () => ({}) } }))
mock.module('@keepkey/hdwallet-keepkey-nodewebusb', () => ({ NodeWebUSBKeepKeyAdapter: { useKeyring: () => ({}) } }))
mock.module('usb', () => ({ usb: new EventEmitter() }))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: '/tmp/kk-pin-wait-guard-unused' } } }))

const { DEVICE_AWAITING_INPUT_MESSAGE, awaitingInput, guardInputWait } = await import('../src/bun/device-gate')
const { EngineController } = await import('../src/bun/engine-controller')
const { wipeOwningDevice } = await import('../src/bun/device-wipe')

const T = Messages.MessageType
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const TINY = new Set<number>([T.MESSAGETYPE_PINMATRIXACK, T.MESSAGETYPE_PASSPHRASEACK, T.MESSAGETYPE_BUTTONACK,
  T.MESSAGETYPE_CANCEL, T.MESSAGETYPE_INITIALIZE])

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
const features = (f: Partial<Messages.Features.AsObject> = {}) => {
  const m = new Messages.Features(); m.setMajorVersion(7); m.setMinorVersion(17); m.setInitialized(true)
  m.setPinProtection(true); m.setPinCached(!!f.pinCached); m.setLabel(f.label ?? 'scripted')
  return frame(T.MESSAGETYPE_FEATURES, m.serializeBinary())
}

type Firmware = '7.17' | '7.16'
type Wait = 'pin' | 'passphrase' | 'button' | null

/** A locked KeepKey, scripted from the wire behaviour above. */
class ScriptedKeepKey implements TransportDelegate {
  received: Array<{ type: number; debug: boolean; wait: Wait }> = []
  wait: Wait = null
  locked = true
  open = true
  /** writeChunk settles this long after the device has replied (a slow USB write). */
  writeDelayMs = 0
  /** The next N reads fail as a USB I/O error would, transport left open. */
  failReads = 0
  /** ChangePin-like: a correct PIN is answered with the next PinMatrixRequest. */
  pinRequestsLeft = 1
  /** Features arrive this long after GetFeatures. */
  featuresDelayMs = 0
  out: Uint8Array[] = []
  private press: (() => void) | null = null
  constructor(readonly fw: Firmware = '7.17', readonly passphrase = false) {}
  async isOpened() { return this.open }
  async getDeviceID() { return 'scripted' }
  async connect() {}
  async tryConnectDebugLink() { return true }
  async disconnect() { this.open = false }
  pressButton() { this.press?.() }
  async writeChunk(buf: Uint8Array, debug?: boolean) {
    const type = (buf[3] << 8) | buf[4]
    this.received.push({ type, debug: !!debug, wait: this.wait })
    if (debug) {
      if (type === T.MESSAGETYPE_DEBUGLINKGETSTATE) this.out.push(frame(T.MESSAGETYPE_DEBUGLINKSTATE))
    } else if (this.wait === 'pin' || this.wait === 'passphrase') {
      this.inWait(type)
    } else if (this.wait === 'button') {
      if (type === T.MESSAGETYPE_BUTTONACK) {
        this.press = () => { this.press = null; this.wait = null; this.out.push(frame(T.MESSAGETYPE_SUCCESS)) }
      } else if (type === T.MESSAGETYPE_CANCEL) { this.wait = null; this.out.push(failure(4, 'Action cancelled by user')) }
    } else {
      this.topLevel(type)
    }
    if (this.writeDelayMs) await sleep(this.writeDelayMs)
  }
  private inWait(type: number) {
    const answer = this.wait === 'pin' ? T.MESSAGETYPE_PINMATRIXACK : T.MESSAGETYPE_PASSPHRASEACK
    if (type === answer) {
      if (this.wait === 'pin' && --this.pinRequestsLeft > 0) { this.out.push(frame(T.MESSAGETYPE_PINMATRIXREQUEST)); return }
      if (this.wait === 'pin' && this.passphrase) { this.locked = false; this.wait = 'passphrase'; this.out.push(frame(T.MESSAGETYPE_PASSPHRASEREQUEST)); return }
      this.locked = false; this.wait = null; this.out.push(frame(T.MESSAGETYPE_SUCCESS))
    } else if (type === T.MESSAGETYPE_CANCEL) {
      this.out.push(this.wait === 'pin' ? failure(6, 'PIN Cancelled') : failure(4, 'Action cancelled by user')); this.wait = null
    } else if (type === T.MESSAGETYPE_INITIALIZE) {
      this.wait = null; this.out.push(features())
    } else if (TINY.has(type)) {
      if (this.fw === '7.17') { this.wait = null; this.out.push(failure(1, 'Unexpected message during protected wait')) }
      // 7.16: another wait's ack is read and ignored
    } else {
      this.out.push(failure(1, 'Unknown message'))
      if (this.fw === '7.17') this.wait = null
    }
  }
  private topLevel(type: number) {
    if (type === T.MESSAGETYPE_GETPUBLICKEY || type === T.MESSAGETYPE_ETHEREUMGETADDRESS) {
      if (this.locked) { this.wait = 'pin'; this.out.push(frame(T.MESSAGETYPE_PINMATRIXREQUEST)) }
      else this.out.push(frame(T.MESSAGETYPE_SUCCESS))
    } else if (type === T.MESSAGETYPE_GETFEATURES || type === T.MESSAGETYPE_INITIALIZE) {
      const reply = features({ pinCached: !this.locked })
      if (this.featuresDelayMs) setTimeout(() => this.out.push(reply), this.featuresDelayMs)
      else this.out.push(reply)
    } else if (type === T.MESSAGETYPE_APPLYSETTINGS) {
      this.wait = 'button'; this.out.push(frame(T.MESSAGETYPE_BUTTONREQUEST))
    } else if (type === T.MESSAGETYPE_RECOVERYDEVICE) {
      this.out.push(frame(T.MESSAGETYPE_CHARACTERREQUEST))
    } else if (TINY.has(type) && type !== T.MESSAGETYPE_INITIALIZE) {
      this.out.push(type === T.MESSAGETYPE_CANCEL ? failure(4, 'Action cancelled') : failure(1, 'Unexpected message'))
    } else {
      this.out.push(frame(T.MESSAGETYPE_SUCCESS))
    }
  }
  async readChunk(): Promise<Uint8Array> {
    for (;;) {
      if (this.failReads > 0) { this.failReads--; throw new Error('LIBUSB_ERROR_IO') }
      if (!this.open) throw new Error('scripted device disconnected')
      const next = this.out.shift()
      if (next) return next
      await sleep(2)
    }
  }
  /** Types the device read while it was waiting for PIN/passphrase input. */
  inputWaitTraffic() { return this.received.filter(r => !r.debug && (r.wait === 'pin' || r.wait === 'passphrase')).map(r => r.type) }
}

async function guarded(device = new ScriptedKeepKey()) {
  const transport = await Transport.create(new core.Keyring(), device)
  guardInputWait(transport)
  return { device, transport: transport as any }
}

const gpk = () => {
  const m = new Messages.GetPublicKey(); m.setAddressNList([0x8000002c, 0x80000000, 0x80000000]); m.setCoinName('Bitcoin')
  return m
}
const pinAck = () => { const m = new Messages.PinMatrixAck(); m.setPin('1'); return m }
const passAck = () => { const m = new Messages.PassphraseAck(); m.setPassphrase(''); return m }
const send = (transport: any, type: number, msg: any) =>
  transport.call(type, msg, { omitLock: true, noWait: true }).then(() => null, (e: any) => e)
const bypass = (transport: any) => send(transport, T.MESSAGETYPE_GETFEATURES, new Messages.GetFeatures())
async function until(predicate: () => boolean, label: string, ms = 2000) {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await sleep(2)
  if (!predicate()) throw new Error(`Timed out waiting for ${label}`)
}

describe.each(['7.17', '7.16'] as const)('guardInputWait, %s firmware', (fw) => {
  test('a request that reaches the PIN wait is refused before the device sees it; the PIN still lands', async () => {
    const { device, transport } = await guarded(new ScriptedKeepKey(fw))
    const unlock = transport.call(T.MESSAGETYPE_GETPUBLICKEY, gpk(), { msgTimeout: core.LONG_TIMEOUT })
    await until(() => awaitingInput(transport) === 'pin', 'PIN request')
    const refused = await bypass(transport)
    expect(refused?.status).toBe(423)
    expect(refused?.message).toBe(DEVICE_AWAITING_INPUT_MESSAGE)
    expect(await send(transport, T.MESSAGETYPE_PINMATRIXACK, pinAck())).toBeNull()
    expect((await unlock).message_enum).toBe(T.MESSAGETYPE_SUCCESS)
    expect(device.inputWaitTraffic()).toEqual([T.MESSAGETYPE_PINMATRIXACK])
    expect(awaitingInput(transport)).toBeNull()
    expect((await transport.call(T.MESSAGETYPE_GETFEATURES, new Messages.GetFeatures())).message_enum).toBe(T.MESSAGETYPE_FEATURES)
  })

  test("the other wait's ack is refused: a stale passphrase in the PIN wait, a stale PIN in the passphrase wait", async () => {
    const { device, transport } = await guarded(new ScriptedKeepKey(fw, true))
    const unlock = transport.call(T.MESSAGETYPE_GETPUBLICKEY, gpk(), { msgTimeout: core.LONG_TIMEOUT })
    await until(() => awaitingInput(transport) === 'pin', 'PIN request')
    expect((await send(transport, T.MESSAGETYPE_PASSPHRASEACK, passAck()))?.status).toBe(423)
    expect(awaitingInput(transport)).toBe('pin') // still guarded: the next intruder is refused too
    expect((await bypass(transport))?.status).toBe(423)
    expect(await send(transport, T.MESSAGETYPE_PINMATRIXACK, pinAck())).toBeNull()
    await until(() => awaitingInput(transport) === 'passphrase', 'passphrase request')
    expect((await send(transport, T.MESSAGETYPE_PINMATRIXACK, pinAck()))?.status).toBe(423)
    expect(await send(transport, T.MESSAGETYPE_PASSPHRASEACK, passAck())).toBeNull()
    expect((await unlock).message_enum).toBe(T.MESSAGETYPE_SUCCESS)
    expect(device.inputWaitTraffic()).toEqual([T.MESSAGETYPE_PINMATRIXACK, T.MESSAGETYPE_PASSPHRASEACK])
  })

  test('an answer with no wait open never goes out: no stray reply for the next caller', async () => {
    const { device, transport } = await guarded(new ScriptedKeepKey(fw))
    expect((await send(transport, T.MESSAGETYPE_PINMATRIXACK, pinAck()))?.status).toBe(409)
    expect((await send(transport, T.MESSAGETYPE_PASSPHRASEACK, passAck()))?.status).toBe(409)
    expect(device.received).toEqual([])
    expect((await transport.call(T.MESSAGETYPE_GETFEATURES, new Messages.GetFeatures())).message_enum).toBe(T.MESSAGETYPE_FEATURES)
  })

  test('a reply that outruns the slow write of the answer keeps its new wait guarded', async () => {
    const device = new ScriptedKeepKey(fw)
    device.pinRequestsLeft = 2 // ChangePin: the first PIN is answered with the second request
    device.writeDelayMs = 30
    const { transport } = await guarded(device)
    const change = transport.call(T.MESSAGETYPE_GETPUBLICKEY, gpk(), { msgTimeout: core.LONG_TIMEOUT })
    await until(() => awaitingInput(transport) === 'pin', 'first PIN request')
    const answer = send(transport, T.MESSAGETYPE_PINMATRIXACK, pinAck())
    await until(() => device.wait === 'pin' && device.received.length === 2 && device.out.length === 0, 'second PIN request read')
    await answer
    expect(awaitingInput(transport)).toBe('pin')
    expect((await bypass(transport))?.status).toBe(423)
    device.writeDelayMs = 0
    await send(transport, T.MESSAGETYPE_PINMATRIXACK, pinAck())
    expect((await change).message_enum).toBe(T.MESSAGETYPE_SUCCESS)
  })

  test('a wait whose read failed (USB I/O error, transport still open) is closed, and its reply consumed', async () => {
    const { device, transport } = await guarded(new ScriptedKeepKey(fw))
    const unlock = transport.call(T.MESSAGETYPE_GETPUBLICKEY, gpk(), { msgTimeout: core.LONG_TIMEOUT }).catch((e: any) => e)
    await until(() => awaitingInput(transport) === 'pin', 'PIN request')
    device.failReads = 1 // the read waiting on the PIN fails; the device never hears of it
    expect((await unlock)?.message).toBe('LIBUSB_ERROR_IO')
    expect(device.inputWaitTraffic()).toEqual([T.MESSAGETYPE_CANCEL]) // the wait was closed...
    expect(device.wait).toBeNull()
    expect(device.out).toEqual([]) // ...and its "PIN Cancelled" read, not left for the next caller
    expect(awaitingInput(transport)).toBeNull()
    const again = transport.call(T.MESSAGETYPE_GETPUBLICKEY, gpk(), { msgTimeout: core.LONG_TIMEOUT })
    await until(() => awaitingInput(transport) === 'pin', 'fresh PIN request')
    await send(transport, T.MESSAGETYPE_PINMATRIXACK, pinAck())
    expect((await again).message_enum).toBe(T.MESSAGETYPE_SUCCESS)
  })
})

describe('guardInputWait: waits that are not PIN or passphrase are unchanged', () => {
  test('a confirm (ButtonRequest) wait passes traffic through, as before', async () => {
    const { device, transport } = await guarded()
    device.locked = false
    const settings = transport.call(T.MESSAGETYPE_APPLYSETTINGS, new Messages.ApplySettings(), { msgTimeout: core.LONG_TIMEOUT })
    await until(() => device.received.some(r => r.type === T.MESSAGETYPE_BUTTONACK), 'ButtonAck')
    expect(awaitingInput(transport)).toBeNull()
    expect(await bypass(transport)).toBeNull()
    device.pressButton()
    await settings.catch(() => {})
  })

  test('a recovery CharacterRequest passes traffic through, as before', async () => {
    const { device, transport } = await guarded()
    const recovery = transport.call(T.MESSAGETYPE_RECOVERYDEVICE, new Messages.RecoveryDevice(), { msgTimeout: core.LONG_TIMEOUT }).catch(() => {})
    await until(() => device.received.length === 1 && device.out.length === 0, 'CharacterRequest read')
    await sleep(10)
    expect(awaitingInput(transport)).toBeNull()
    expect(await bypass(transport)).toBeNull()
    void recovery
  })
})

describe.each(['7.17', '7.16'] as const)('EngineController on a USB/HID-like transport, %s firmware', (fw) => {
  async function engineWith(device: ScriptedKeepKey, activeTransport = 'webusb') {
    const transport = await Transport.create(new core.Keyring(), device)
    const wallet = create(transport)
    const engine = new EngineController()
    Object.assign(engine, { wallet, activeTransport, cachedFeatures: { initialized: true, pinProtection: true }, lastState: 'needs_pin' })
    ;(engine as any).attachTransportListeners()
    return { engine, wallet: wallet as any, transport: transport as any }
  }
  const swap = async (engine: any, device: ScriptedKeepKey) => {
    engine.clearWallet()
    const transport = await Transport.create(new core.Keyring(), device)
    Object.assign(engine, { wallet: create(transport), activeTransport: 'webusb', cachedFeatures: { initialized: true, pinProtection: true } })
    engine.attachTransportListeners()
  }

  test('PIN entry unlocks, and a request bypassing the lock in the wait is refused', async () => {
    const device = new ScriptedKeepKey(fw)
    const { engine, transport } = await engineWith(device)
    const unlock = engine.promptPin()
    await until(() => awaitingInput(transport) === 'pin', 'PIN request')
    expect((await bypass(transport))?.status).toBe(423)
    await engine.sendPin('1')
    await unlock
    expect(engine.getDeviceState().state).toBe('ready')
    expect(device.inputWaitTraffic()).toEqual([T.MESSAGETYPE_PINMATRIXACK])
  })

  test('PIN then passphrase unlocks; a stale PIN in the passphrase wait is refused', async () => {
    const device = new ScriptedKeepKey(fw, true)
    const { engine, transport } = await engineWith(device)
    const unlock = engine.promptPin()
    await until(() => awaitingInput(transport) === 'pin', 'PIN request')
    await engine.sendPin('1')
    await until(() => awaitingInput(transport) === 'passphrase', 'passphrase request')
    await expect(engine.sendPin('1')).rejects.toMatchObject({ status: 423 })
    await engine.sendPassphrase('')
    await unlock
    expect(device.inputWaitTraffic()).toEqual([T.MESSAGETYPE_PINMATRIXACK, T.MESSAGETYPE_PASSPHRASEACK])
  })

  test('Cancel reaches the PIN wait after another call cleared userActionRequired, and the queue behind it holds', async () => {
    const device = new ScriptedKeepKey(fw)
    const { engine, wallet, transport } = await engineWith(device)
    const unlock = engine.promptPin().catch((e: any) => e)
    await until(() => awaitingInput(transport) === 'pin', 'PIN request')
    const queued = wallet.getFeatures() // waits on hdwallet's call lock behind the PIN request
    transport.userActionRequired = false // what any completed call (a DebugLink read) leaves behind
    await engine.cancelDevicePrompt()
    expect((await unlock)?.message?.code).toBe(6)
    await queued
    expect(device.received.map(r => [r.type, r.wait])).toEqual([
      [T.MESSAGETYPE_GETPUBLICKEY, null], [T.MESSAGETYPE_CANCEL, 'pin'], [T.MESSAGETYPE_GETFEATURES, null],
    ])
  })

  test('a wipe during the PIN wait cancels it even after userActionRequired was cleared, then wipes', async () => {
    const device = new ScriptedKeepKey(fw)
    const { engine, transport } = await engineWith(device)
    ;(engine as any).applyState('needs_pin')
    await until(() => awaitingInput(transport) === 'pin', 'PIN request')
    transport.userActionRequired = false
    await wipeOwningDevice(engine as any, (wipe) => wipe(), async () => {})
    expect(device.received.map(r => r.type)).toEqual([T.MESSAGETYPE_GETPUBLICKEY, T.MESSAGETYPE_CANCEL, T.MESSAGETYPE_WIPEDEVICE])
  })

  test("a dropped connection's prompt neither clears the next connection's prompt nor retries on it", async () => {
    const oldDevice = new ScriptedKeepKey(fw)
    const { engine } = await engineWith(oldDevice)
    ;(engine as any).applyState('needs_pin') // auto prompt-pin on the old connection
    await until(() => oldDevice.wait === 'pin', 'old PIN request')
    const device = new ScriptedKeepKey(fw)
    await swap(engine, device)
    ;(engine as any).applyState('needs_pin') // and on the new one
    await until(() => device.wait === 'pin', 'new PIN request')
    let prompts = 0
    const promptPin = engine.promptPin.bind(engine)
    engine.promptPin = () => { prompts++; return promptPin() }
    await oldDevice.disconnect() // the old prompt fails now
    await sleep(50)
    expect((engine as any).promptPinActive).toBe(true)
    await sleep(3300) // past the 3 s retry
    expect(prompts).toBe(0)
    expect(device.received.map(r => r.type)).toEqual([T.MESSAGETYPE_GETPUBLICKEY])
  }, 10_000)

  test("a dropped connection's passphrase prompt is not re-issued on the next connection", async () => {
    const oldDevice = new ScriptedKeepKey(fw)
    const { engine } = await engineWith(oldDevice)
    ;(engine as any).applyState('needs_passphrase') // schedules the passphrase auto-prompt
    const device = new ScriptedKeepKey(fw)
    await swap(engine, device) // before that timer runs
    await sleep(50)
    expect(oldDevice.received).toEqual([])
    expect(device.received).toEqual([])
  })

  test('features the old connection read after its unlock never land in the next connection', async () => {
    const oldDevice = new ScriptedKeepKey(fw)
    const { engine } = await engineWith(oldDevice)
    const unlock = engine.promptPin().catch((e: any) => e)
    await until(() => oldDevice.wait === 'pin', 'PIN request')
    oldDevice.featuresDelayMs = 100
    await engine.sendPin('1')
    // The unlock succeeded; its GetFeatures is now on the wire. Switch before the reply is read.
    await until(() => oldDevice.received.some(r => r.type === T.MESSAGETYPE_GETFEATURES), 'old GetFeatures')
    const device = new ScriptedKeepKey(fw)
    await swap(engine, device)
    ;(engine as any).lastState = 'disconnected'
    await unlock
    expect(engine.getDeviceState().state).toBe('disconnected')
    expect((engine as any).cachedFeatures?.label).toBeUndefined()
  })
})
