/**
 * The emulator's wrong-PIN countdown is waited out however long it is.
 *
 * Firmware (pin_sm.c pin_protect) counts down 2^fails seconds after 3+ wrong PINs
 * before it sends PinMatrixRequest, and reads no USB meanwhile: 512 s at 9 fails.
 * A read deadline shorter than that ended the unlock's read with a plain Error;
 * the auto-prompt then wrote another GetPublicKey into the firmware that was not
 * reading. When the countdown ended, that request landed in the PIN wait (Failure
 * on 7.17, wait ended) and the next unlock counted down 512 s again: no way in.
 *
 * Real engine, hdwallet and EmulatorTransportDelegate; the FFI module is replaced
 * by a scripted 7.17 firmware whose countdown runs on Date.now, so the clock jumps.
 *
 * Run: bun test __tests__/emulator-countdown.test.ts
 */
import { afterEach, expect, mock, setSystemTime, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import * as core from '@keepkey/hdwallet-core'
import * as Messages from '@keepkey/device-protocol/lib/messages_pb'
import * as Ethereum from '@keepkey/device-protocol/lib/messages-ethereum_pb'
import { Transport, create } from '@keepkey/hdwallet-keepkey'

const T = Messages.MessageType
const COUNTDOWN_MS = 512_000 // 9 failures
const SEED_ADDRESS = '0x0000000000000000000000000000000000000001'
const frame = (type: number, body: Uint8Array = new Uint8Array()) => {
  const f = new Uint8Array(64); f.set([0x3f, 0x23, 0x23, type >> 8, type & 255, 0, 0, 0, body.length]); f.set(body, 9); return f
}
const failure = (code: number, text: string) => {
  const m = new Messages.Failure(); m.setCode(code); m.setMessage(text); return frame(T.MESSAGETYPE_FAILURE, m.serializeBinary())
}

/** 7.17 firmware, locked, 9 wrong PINs behind it. */
const fw = {
  inbox: [] as number[], outbox: [] as Uint8Array[], received: [] as number[],
  locked: true, wait: false, countdownEnd: 0,
  run() {
    while (this.inbox.length) {
      if (Date.now() < this.countdownEnd) return // counting down: reads no USB
      const type = this.inbox[0]
      if (this.wait) {
        this.inbox.shift(); this.wait = false
        if (type === T.MESSAGETYPE_PINMATRIXACK) { this.locked = false; this.outbox.push(frame(T.MESSAGETYPE_SUCCESS)) }
        else this.outbox.push(failure(1, 'Unknown message')) // and the wait ends
      } else if (type === T.MESSAGETYPE_GETPUBLICKEY && this.locked) {
        if (!this.countdownEnd) { this.countdownEnd = Date.now() + COUNTDOWN_MS; continue }
        this.inbox.shift(); this.countdownEnd = 0; this.wait = true
        this.outbox.push(frame(T.MESSAGETYPE_PINMATRIXREQUEST))
      } else {
        this.inbox.shift()
        if (type === T.MESSAGETYPE_GETFEATURES) {
          const m = new Messages.Features(); m.setMajorVersion(7); m.setMinorVersion(17); m.setInitialized(true); m.setPinProtection(true); m.setPinCached(!this.locked)
          this.outbox.push(frame(T.MESSAGETYPE_FEATURES, m.serializeBinary()))
        } else if (type === T.MESSAGETYPE_ETHEREUMGETADDRESS && !this.locked) {
          const m = new Ethereum.EthereumAddress(); m.setAddressStr(SEED_ADDRESS)
          this.outbox.push(frame(T.MESSAGETYPE_ETHEREUMADDRESS, m.serializeBinary()))
        } else this.outbox.push(frame(T.MESSAGETYPE_SUCCESS))
      }
    }
  },
}
mock.module('../src/bun/emulator', () => ({
  emuWrite: (data: Uint8Array, iface: number) => {
    if (iface === 0) { const type = (data[3] << 8) | data[4]; fw.received.push(type); fw.inbox.push(type) }
    fw.run(); return true
  },
  emuRead: (iface: number) => { if (iface) return null; fw.run(); return fw.outbox.shift() ?? null },
  getEmulatorStatus: () => ({ state: 'running' }),
  getEmulatorInstance: () => 1,
  getActiveFlashName: () => 'countdown-test',
  flushRingBuffers: () => {},
}))
mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: { useKeyring: () => ({}) } }))
mock.module('@keepkey/hdwallet-keepkey-nodewebusb', () => ({ NodeWebUSBKeepKeyAdapter: { useKeyring: () => ({}) } }))
mock.module('usb', () => ({ usb: new EventEmitter() }))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData: '/tmp/kk-emulator-countdown-unused' } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData: '/tmp/kk-emulator-countdown-unused' } }))
const { EmulatorTransportDelegate } = await import('../src/bun/emulator-transport')
const { EngineController } = await import('../src/bun/engine-controller')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
afterEach(() => setSystemTime())

test('a 512 s countdown is waited out: one unlock request, then the PIN prompt, then unlocked', async () => {
  const delegate = new EmulatorTransportDelegate()
  const transport = await Transport.create(new core.Keyring(), delegate)
  await transport.connect()
  const engine = new EngineController()
  const pins: string[] = []
  engine.on('pin-request', ({ type }: any) => pins.push(type))
  Object.assign(engine, { wallet: create(transport), activeTransport: 'emulator', cachedFeatures: { initialized: true, pinProtection: true } })
  ;(engine as any).attachTransportListeners()
  ;(engine as any).applyState('needs_pin')
  await sleep(20)
  expect(fw.received).toEqual([]) // Detecting a lock stays passive.
  const unlock = engine.requestDeviceUnlock() // Foreground intent starts the countdown once.
  await sleep(50)
  expect(fw.received).toEqual([T.MESSAGETYPE_GETPUBLICKEY])
  setSystemTime(new Date(Date.now() + 400_000)) // past any 360 s read deadline, inside the countdown
  await sleep(3500) // past the auto-prompt's 3 s retry
  expect(engine.getDeviceState().state).toBe('needs_pin')
  expect(engine.getDeviceState().pinPromptOpen).toBe(false) // the pad shows disabled
  expect(fw.received).toEqual([T.MESSAGETYPE_GETPUBLICKEY]) // nothing written into a firmware that is not reading
  setSystemTime(new Date(Date.now() + 120_000)) // the countdown ends
  const deadline = Date.now() + 2000
  while (!pins.length && Date.now() < deadline) await sleep(5)
  expect(pins).toEqual(['current'])
  await engine.sendPin('1')
  await unlock // Includes Features and verification of the effective wallet identity.
  expect(engine.getDeviceState().state).toBe('ready')
  expect(engine.currentSeedEthAddress).toBe(SEED_ADDRESS)
  expect(engine.unlockRequest).toBeNull()
  expect(fw.received).toEqual([T.MESSAGETYPE_GETPUBLICKEY, T.MESSAGETYPE_PINMATRIXACK, T.MESSAGETYPE_GETFEATURES, T.MESSAGETYPE_ETHEREUMGETADDRESS])
  expect(fw.inbox).toEqual([])
  expect(fw.outbox).toEqual([])
  await transport.disconnect()
}, 15_000)
