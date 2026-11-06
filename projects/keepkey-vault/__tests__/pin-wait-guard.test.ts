/**
 * Nothing but the answer reaches a KeepKey waiting for its PIN or passphrase.
 *
 * 7.17 firmware answers any other message in that wait with Failure "Unknown
 * message" and ends the wait (pin_sm.c check_for_pin_ack): the request that was
 * waiting fails and the PIN the user is typing goes nowhere. Dev log 2026-11-06:
 * an unlock request queued behind a seed-fingerprint request that was waiting on
 * the PIN landed in that wait, again and again, every 240 s.
 *
 * The device here is scripted to behave like that firmware; hdwallet's Transport
 * and the engine are real.
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

/** A locked KeepKey on 7.17: seed access asks for the PIN; in that wait only the tiny messages count. */
class LockedDevice implements TransportDelegate {
  received: Array<{ type: number; debug: boolean; inWait: boolean }> = []
  wait: 'pin' | null = null
  locked = true
  open = true
  private out: Uint8Array[] = []
  async isOpened() { return this.open }
  async getDeviceID() { return 'scripted' }
  async connect() {}
  async tryConnectDebugLink() { return true }
  async disconnect() { this.open = false }
  async writeChunk(buf: Uint8Array, debug?: boolean) {
    const type = (buf[3] << 8) | buf[4]
    this.received.push({ type, debug: !!debug, inWait: !!this.wait })
    if (debug) { if (type === T.MESSAGETYPE_DEBUGLINKGETSTATE) this.out.push(frame(T.MESSAGETYPE_DEBUGLINKSTATE)); return }
    if (this.wait) {
      this.wait = null
      if (type === T.MESSAGETYPE_PINMATRIXACK) { this.locked = false; this.out.push(frame(T.MESSAGETYPE_SUCCESS)) }
      else if (type === T.MESSAGETYPE_CANCEL) this.out.push(failure(6, 'PIN Cancelled'))
      else if (type === T.MESSAGETYPE_INITIALIZE) this.out.push(frame(T.MESSAGETYPE_FEATURES))
      else this.out.push(failure(1, 'Unknown message'))
      return
    }
    if ((type === T.MESSAGETYPE_GETPUBLICKEY || type === T.MESSAGETYPE_ETHEREUMGETADDRESS) && this.locked) {
      this.wait = 'pin'
      this.out.push(frame(T.MESSAGETYPE_PINMATRIXREQUEST))
    } else if (type === T.MESSAGETYPE_GETFEATURES || type === T.MESSAGETYPE_INITIALIZE) {
      this.out.push(frame(T.MESSAGETYPE_FEATURES))
    } else {
      this.out.push(frame(T.MESSAGETYPE_SUCCESS))
    }
  }
  async readChunk(): Promise<Uint8Array> {
    for (;;) {
      if (!this.open) throw new Error('scripted device disconnected')
      const next = this.out.shift()
      if (next) return next
      await sleep(2)
    }
  }
}

async function guarded() {
  const device = new LockedDevice()
  const transport = await Transport.create(new core.Keyring(), device)
  guardInputWait(transport)
  return { device, transport: transport as any }
}

const gpk = () => {
  const m = new Messages.GetPublicKey(); m.setAddressNList([0x8000002c, 0x80000000, 0x80000000]); m.setCoinName('Bitcoin')
  return m
}
const pinAck = () => { const m = new Messages.PinMatrixAck(); m.setPin('1'); return m }
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 2000
  while (!predicate() && Date.now() < deadline) await sleep(2)
  if (!predicate()) throw new Error(`Timed out waiting for ${label}`)
}

describe('guardInputWait', () => {
  test('a request that reaches the PIN wait is refused before the device sees it; the PIN still lands', async () => {
    const { device, transport } = await guarded()
    const unlock = transport.call(T.MESSAGETYPE_GETPUBLICKEY, gpk(), { msgTimeout: core.LONG_TIMEOUT })
    await until(() => awaitingInput(transport) === 'pin', 'PIN request')
    const refused = await transport.call(T.MESSAGETYPE_GETFEATURES, new Messages.GetFeatures(), { omitLock: true })
      .then(() => null, (e: any) => e)
    expect(refused?.status).toBe(423)
    expect(refused?.message).toBe(DEVICE_AWAITING_INPUT_MESSAGE)
    expect(device.received.filter(r => r.inWait).map(r => r.type)).toEqual([])
    await transport.call(T.MESSAGETYPE_PINMATRIXACK, pinAck(), { omitLock: true, noWait: true })
    expect((await unlock).message_enum).toBe(T.MESSAGETYPE_SUCCESS)
    expect(awaitingInput(transport)).toBeNull()
    expect((await transport.call(T.MESSAGETYPE_GETFEATURES, new Messages.GetFeatures())).message_enum).toBe(T.MESSAGETYPE_FEATURES)
  })

  test('Cancel and Initialize close the wait; DebugLinkGetState is read in it, other debug messages are not', async () => {
    const { device, transport } = await guarded()
    const first = transport.call(T.MESSAGETYPE_GETPUBLICKEY, gpk(), { msgTimeout: core.LONG_TIMEOUT }).catch((e: any) => e)
    await until(() => awaitingInput(transport) === 'pin', 'PIN request')
    expect((await transport.call(T.MESSAGETYPE_DEBUGLINKGETSTATE, new Messages.DebugLinkGetState(), { debugLink: true, omitLock: true }))
      .message_enum).toBe(T.MESSAGETYPE_DEBUGLINKSTATE)
    const debug = await transport.call(T.MESSAGETYPE_DEBUGLINKFILLCONFIG, new Messages.DebugLinkFillConfig(), { debugLink: true, omitLock: true })
      .then(() => null, (e: any) => e)
    expect(debug?.status).toBe(423)
    await transport.call(T.MESSAGETYPE_CANCEL, new Messages.Cancel(), { omitLock: true, noWait: true })
    expect((await first)?.message?.code).toBe(6)
    const second = transport.call(T.MESSAGETYPE_GETPUBLICKEY, gpk(), { msgTimeout: core.LONG_TIMEOUT })
    await until(() => awaitingInput(transport) === 'pin', 'second PIN request')
    await transport.call(T.MESSAGETYPE_INITIALIZE, new Messages.Initialize(), { omitLock: true, noWait: true })
    expect((await second).message_enum).toBe(T.MESSAGETYPE_FEATURES)
    expect(awaitingInput(transport)).toBeNull()
    expect(device.received.filter(r => r.inWait && !r.debug).map(r => r.type)).toEqual([T.MESSAGETYPE_CANCEL, T.MESSAGETYPE_INITIALIZE])
  })
})

describe('EngineController PIN prompt', () => {
  async function engineWith(device: LockedDevice) {
    const transport = await Transport.create(new core.Keyring(), device)
    const wallet = create(transport)
    const engine = new EngineController()
    Object.assign(engine, { wallet, activeTransport: 'emulator', cachedFeatures: { initialized: true, pinProtection: true } })
    ;(engine as any).attachTransportListeners()
    return { engine, wallet: wallet as any, transport: transport as any }
  }

  test('Cancel reaches the PIN wait even after another call cleared userActionRequired, and the queue behind it holds', async () => {
    const device = new LockedDevice()
    const { engine, wallet, transport } = await engineWith(device)
    const unlock = engine.promptPin().catch((e: any) => e)
    await until(() => awaitingInput(transport) === 'pin', 'PIN request')
    const features = wallet.getFeatures() // queued behind the PIN request on hdwallet's call lock
    transport.userActionRequired = false // what any completed call (a DebugLink read) leaves behind
    await engine.cancelDevicePrompt()
    expect((await unlock)?.message?.code).toBe(6)
    await features
    expect(device.received.map(r => [r.type, r.inWait])).toEqual([
      [T.MESSAGETYPE_GETPUBLICKEY, false], [T.MESSAGETYPE_CANCEL, true], [T.MESSAGETYPE_GETFEATURES, false],
    ])
  })

  test("a dropped connection's prompt neither clears the next connection's prompt nor retries on it", async () => {
    const oldDevice = new LockedDevice()
    const { engine } = await engineWith(oldDevice)
    ;(engine as any).applyState('needs_pin') // auto prompt-pin on the old connection
    await until(() => oldDevice.wait === 'pin', 'old PIN request')
    ;(engine as any).clearWallet()
    const device = new LockedDevice()
    const transport = await Transport.create(new core.Keyring(), device)
    Object.assign(engine, { wallet: create(transport), activeTransport: 'emulator', cachedFeatures: { initialized: true, pinProtection: true } })
    ;(engine as any).attachTransportListeners()
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
})
