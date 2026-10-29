/**
 * Wiping a locked KeepKey: the wipe owns the device until it answers.
 *
 * 2026-10-22 (vault-backend.log 17:06:46Z): Cancel ended the PIN prompt, the
 * device showed its wipe confirmation, a REST get-features poll reached the
 * device mid-confirmation ("Unknown message"), the wipe got "Unexpected
 * message" and fell back to the PIN prompt.
 *
 * 2026-10-24 (1.6.5 support case): a device with many wrong PINs counts down
 * 2^fails seconds before showing the PIN matrix and reads no USB meanwhile.
 * The wipe queued behind the unlock request and died with "Timeout during
 * device response after 300000ms", before and after the countdown.
 *
 * Run: bun test __tests__/device-wipe.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import * as path from 'path'
import * as core from '@keepkey/hdwallet-core'
import * as Messages from '@keepkey/device-protocol/lib/messages_pb'
import { Transport } from '@keepkey/hdwallet-keepkey/dist/transport'
import {
  wipeOwningDevice, WIPE_BUSY_MESSAGE, WIPE_AFTER_REPLUG_MESSAGE, WIPE_UNREACHABLE_MESSAGE, type WipeHost,
} from '../src/bun/device-wipe'
import { requestUnlock } from '../src/bun/pin-unlock'
import { DEVICE_LOCKED_MESSAGE, gateRestWrites, restRequest, restWriteRefusal, type GateState } from '../src/bun/device-gate'
import { HttpError } from '../src/bun/auth'

type Link = { matrixShown?: boolean; open?: boolean; unlock?: Promise<unknown> | null; canDefer?: boolean }

/** A locked device whose wipe confirmation stays on screen until `press()`. */
function lockedDevice(outcome: 'confirm' | 'refuse' = 'confirm', link: Link = {}) {
  const log: string[] = []
  let press!: () => void
  const onScreen = new Promise<void>((resolve) => { press = resolve })
  const host: WipeHost & { reprompts: number; deferred: number } = {
    reprompts: 0,
    deferred: 0,
    wipeInProgress: false,
    unlockRequest: link.unlock ?? null,
    deferWipeUntilReplug() { if (link.canDefer === false) return false; this.deferred++; return true },
    repromptPin() { this.reprompts++ },
    wallet: {
      transport: { userActionRequired: link.matrixShown ?? true, isOpened: async () => link.open ?? true },
      async cancel() { log.push('cancel') },
      async wipe() {
        log.push('wipe')
        await onScreen
        if (outcome === 'refuse') throw new Error('Action cancelled by user')
      },
    },
  }
  return { host, log, press: () => press() }
}
const direct = (wipe: () => Promise<unknown>) => wipe()
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('wipeOwningDevice', () => {
  test('cancels the pending PIN prompt before wiping, then settles', async () => {
    const { host, log, press } = lockedDevice()
    const done = wipeOwningDevice(host, direct, async () => { log.push('settle') })
    await tick()
    press()
    await done
    expect(log).toEqual(['cancel', 'wipe', 'settle'])
    expect(host.wipeInProgress).toBe(false)
    expect(host.reprompts).toBe(0)
  })

  test('owns the device for the whole confirmation: a second caller is refused, not sent', async () => {
    const { host, log, press } = lockedDevice()
    const done = wipeOwningDevice(host, direct, async () => {})
    // Owned synchronously, before the first await: nothing can slip in between check and claim.
    expect(host.wipeInProgress).toBe(true)
    await expect(wipeOwningDevice(host, direct, async () => {})).rejects.toThrow(WIPE_BUSY_MESSAGE)
    await tick()
    expect(log).toEqual(['cancel', 'wipe'])
    press()
    await done
    expect(host.wipeInProgress).toBe(false)
  })

  test('the device is free again before settle re-reads it (syncState backs off during a wipe)', async () => {
    const { host, press } = lockedDevice()
    let ownedDuringSettle: boolean | undefined
    const done = wipeOwningDevice(host, direct, async () => { ownedDuringSettle = host.wipeInProgress })
    await tick()
    press()
    await done
    expect(ownedDuringSettle).toBe(false)
  })

  test('a refused wipe releases the device and brings the PIN prompt back', async () => {
    const { host, press } = lockedDevice('refuse')
    const done = wipeOwningDevice(host, direct, async () => {})
    await tick()
    press()
    await expect(done).rejects.toThrow('Action cancelled by user')
    expect(host.wipeInProgress).toBe(false)
    expect(host.reprompts).toBe(1)
  })

  test('device counting down after wrong PINs: nothing is sent, the wipe waits for the replug', async () => {
    const { host, log } = lockedDevice('confirm', { unlock: new Promise(() => {}), matrixShown: false })
    const outcome = await Promise.race([
      wipeOwningDevice(host, direct, async () => {}).then(() => 'wiped', (e: Error) => e.message),
      new Promise((r) => setTimeout(() => r('hung'), 1000)),
    ])
    expect(outcome).toBe(WIPE_AFTER_REPLUG_MESSAGE)
    expect(log).toEqual([])
    expect(host.deferred).toBe(1)
    expect(host.wipeInProgress).toBe(false)
    expect(host.reprompts).toBe(0) // a new PIN request would restart the countdown
  })

  test('transport quarantined by the unlock timeout: same, wipe on the replug', async () => {
    const { host, log } = lockedDevice('confirm', { open: false })
    await expect(wipeOwningDevice(host, direct, async () => {})).rejects.toThrow(WIPE_AFTER_REPLUG_MESSAGE)
    expect(log).toEqual([])
    expect(host.deferred).toBe(1)
  })

  test('unreachable but nothing to wait out (emulator, unlocked device): no deferred wipe', async () => {
    const { host, log } = lockedDevice('confirm', { open: false, canDefer: false })
    await expect(wipeOwningDevice(host, direct, async () => {})).rejects.toThrow(WIPE_UNREACHABLE_MESSAGE)
    expect(log).toEqual([])
    expect(host.wipeInProgress).toBe(false)
  })

  test('PIN matrix showing: the cancelled unlock settles before the wipe is sent', async () => {
    let unlockFail!: () => void
    const unlock = new Promise((_, reject) => { unlockFail = () => reject(new Error('PIN Cancelled')) })
    const { host, log, press } = lockedDevice('confirm', { unlock, matrixShown: true })
    const done = wipeOwningDevice(host, direct, async () => {})
    await tick()
    expect(log).toEqual(['cancel']) // the wipe must not race the unlock's read
    unlockFail()
    await tick()
    expect(log).toEqual(['cancel', 'wipe'])
    press()
    await done
  })

  test('no device: refused before anything is sent', async () => {
    const host: WipeHost = { wallet: null, wipeInProgress: false, unlockRequest: null, deferWipeUntilReplug: () => true, repromptPin() {} }
    await expect(wipeOwningDevice(host, direct, async () => {})).rejects.toThrow('No device connected')
    expect(host.wipeInProgress).toBe(false)
  })
})

describe('with the real hdwallet transport', () => {
  /** A KeepKey in its PIN-failure countdown: takes writes, never answers. `unplug()` ends the pending read. */
  function countingDownKeepKey() {
    const written: number[] = []
    let unplug!: () => void
    const unplugged = new Promise<never>((_, reject) => { unplug = () => reject(new Error('device unplugged')) })
    unplugged.catch(() => {})
    const transport = new Transport(new core.Keyring(), {
      isOpened: async () => true,
      getDeviceID: async () => 'countdown',
      connect: async () => {},
      disconnect: async () => {},
      // Chunk = [63, '#', '#', type hi, type lo, ...]; record the message type of each frame start.
      async writeChunk(buf: Uint8Array) { if (buf[1] === 0x23 && buf[2] === 0x23) written.push((buf[3] << 8) | buf[4]) },
      readChunk: () => unplugged,
    })
    return { transport, written, unplug }
  }

  test('during the countdown hdwallet cancel() sends nothing, so the wipe must not be sent either', async () => {
    const { transport, written, unplug } = countingDownKeepKey()
    const unlock = requestUnlock(transport)
    unlock.catch(() => {})
    await tick()
    expect(written).toEqual([Messages.MessageType.MESSAGETYPE_GETPUBLICKEY])
    expect(transport.userActionRequired).toBe(false) // why cancel() is a no-op here (the 1.6.5 bug)

    let deferred = 0
    const host: WipeHost = {
      wallet: {
        transport,
        cancel: () => transport.cancel(),
        wipe: () => transport.call(Messages.MessageType.MESSAGETYPE_WIPEDEVICE, new Messages.WipeDevice()),
      },
      wipeInProgress: false,
      unlockRequest: unlock,
      deferWipeUntilReplug: () => { deferred++; return true },
      repromptPin() {},
    }
    // Bounded: the 1.6.5 behaviour is a wipe that hangs behind the unlock, and a hang must fail, not stall CI.
    const outcome = await Promise.race([
      wipeOwningDevice(host, direct, async () => {}).then(() => 'wiped', (e: Error) => e.message),
      new Promise((r) => setTimeout(() => r('hung behind the unlock'), 1000)),
    ])
    unplug()
    expect(outcome).toBe(WIPE_AFTER_REPLUG_MESSAGE)
    expect(deferred).toBe(1)
    expect(written).toEqual([Messages.MessageType.MESSAGETYPE_GETPUBLICKEY]) // no Cancel, no WipeDevice
    await expect(unlock).rejects.toThrow('device unplugged')
  })
})

describe('REST writes to the device (device-gate.ts)', () => {
  const free: GateState = { wipeInProgress: false, wipeOnReconnect: false, locked: false }
  const T = Messages.MessageType
  const asRest = { whileLocked: false }

  test("a wipe owns the device outright: only its own messages go, Desktop's queued calls included", () => {
    const wiping = { ...free, wipeInProgress: true }
    for (const own of [T.MESSAGETYPE_CANCEL, T.MESSAGETYPE_WIPEDEVICE, T.MESSAGETYPE_BUTTONACK]) expect(restWriteRefusal(wiping, own, undefined)).toBeNull()
    expect(restWriteRefusal(wiping, T.MESSAGETYPE_RECOVERYDEVICE, undefined)?.status).toBe(409) // the wizard's verify step
    expect(restWriteRefusal(wiping, T.MESSAGETYPE_GETPUBLICKEY, undefined)?.status).toBe(409) // the unlock retry
    expect(restWriteRefusal(wiping, T.MESSAGETYPE_GETFEATURES, asRest)?.status).toBe(409)
    expect(restWriteRefusal(wiping, T.MESSAGETYPE_PINMATRIXACK, undefined)?.status).toBe(409)
  })

  test('outside a wipe only REST requests are gated, and replies to the device always pass', () => {
    expect(restWriteRefusal({ ...free, locked: true }, T.MESSAGETYPE_GETPUBLICKEY, undefined)).toBeNull() // Desktop's own unlock
    expect(restWriteRefusal(free, T.MESSAGETYPE_GETPUBLICKEY, asRest)).toBeNull()
  })

  test('a locked device refuses REST seed requests with 423, but not routes that never ask for the PIN', () => {
    const locked = { ...free, locked: true }
    expect(restWriteRefusal(locked, T.MESSAGETYPE_GETADDRESS, asRest)).toEqual({ status: 423, message: DEVICE_LOCKED_MESSAGE })
    expect(restWriteRefusal(locked, T.MESSAGETYPE_GETFEATURES, { whileLocked: true })).toBeNull()
    expect(restWriteRefusal(locked, T.MESSAGETYPE_PINMATRIXACK, asRest)).toBeNull()
    expect(restWriteRefusal({ ...free, wipeOnReconnect: true }, T.MESSAGETYPE_GETADDRESS, asRest)?.status).toBe(409)
  })

  test("while Desktop holds the device, every new REST request is refused; Desktop's own calls and replies pass", () => {
    const held = { ...free, exclusive: 'creating a Safe' }
    expect(restWriteRefusal(held, T.MESSAGETYPE_ETHEREUMSIGNTX, asRest)).toEqual({ status: 409, message: 'KeepKey is busy: creating a Safe. Try again when it finishes.' })
    expect(restWriteRefusal(held, T.MESSAGETYPE_ETHEREUMSIGNTX, undefined)).toBeNull()
    expect(restWriteRefusal(held, T.MESSAGETYPE_BUTTONACK, asRest)).toBeNull()
  })

  /** Takes writes, answers each with an empty Features once released. */
  function quietKeepKey() {
    const written: number[] = []
    const replies: Array<(b: Uint8Array) => void> = []
    const transport = new Transport(new core.Keyring(), {
      isOpened: async () => true, getDeviceID: async () => 'gate', connect: async () => {}, disconnect: async () => {},
      async writeChunk(buf: Uint8Array) { if (buf[1] === 0x23 && buf[2] === 0x23) written.push((buf[3] << 8) | buf[4]) },
      readChunk: () => new Promise<Uint8Array>((r) => replies.push(r)),
    })
    const features = () => { const b = new Uint8Array(64); b.set([0x3f, 0x23, 0x23, 0, T.MESSAGETYPE_FEATURES, 0, 0, 0, 0]); replies.shift()!(b) }
    const failure = () => { const b = new Uint8Array(64); b.set([0x3f, 0x23, 0x23, 0, T.MESSAGETYPE_FAILURE, 0, 0, 0, 0]); replies.shift()!(b) }
    return { transport, written, features, failure }
  }

  test("the wipe's cancel releases Desktop's queued PIN request; it is refused, the wipe goes (hardware test 2026-10-24)", async () => {
    const { transport, written, features, failure } = quietKeepKey()
    const state = { ...free, locked: true }
    gateRestWrites(transport, () => state)
    // Desktop's unlock is showing the PIN grid; the wizard's verify step waits behind it.
    const unlock = transport.call(T.MESSAGETYPE_GETPUBLICKEY, new Messages.GetPublicKey(), { msgTimeout: 2000 }).catch((e) => e)
    await tick()
    const verify = transport.call(T.MESSAGETYPE_RECOVERYDEVICE, new Messages.RecoveryDevice(), { msgTimeout: 2000 }).catch((e) => e)
    ;(transport as any).userActionRequired = true // the device sent PinMatrixRequest
    state.wipeInProgress = true
    await transport.cancel() // device-wipe.ts order: Cancel, wait for the unlock to settle, then wipe
    failure() // "PIN Cancelled" ends the unlock; the queued verify step goes out next
    await unlock
    const wipe = transport.call(T.MESSAGETYPE_WIPEDEVICE, new Messages.WipeDevice(), { msgTimeout: 2000 }).catch((e) => e)
    const refused = await verify
    expect(refused).toBeInstanceOf(HttpError)
    expect(refused.status).toBe(409)
    await tick()
    expect(written).toEqual([T.MESSAGETYPE_GETPUBLICKEY, T.MESSAGETYPE_CANCEL, T.MESSAGETYPE_WIPEDEVICE])
    features()
    await wipe
  })

  test('a REST request admitted before a wipe began is refused when it reaches the device (hardware test 2026-10-24)', async () => {
    const { transport, written, features } = quietKeepKey()
    const state = { ...free }
    gateRestWrites(transport, () => state)
    const desktop = transport.call(T.MESSAGETYPE_GETFEATURES, new Messages.GetFeatures(), { msgTimeout: 2000 })
    // The REST request passes every handler check, then waits on the transport lock.
    const queued = restRequest.run({ whileLocked: false }, () =>
      transport.call(T.MESSAGETYPE_GETADDRESS, new Messages.GetAddress(), { msgTimeout: 2000 })).catch((e) => e)
    await tick()
    state.wipeInProgress = true // the wipe starts while it waits
    features()
    await desktop
    const refused = await queued
    expect(refused).toBeInstanceOf(HttpError)
    expect(refused.status).toBe(409)
    expect(written).toEqual([T.MESSAGETYPE_GETFEATURES]) // the GetAddress never reached the device
  })
})

describe('REST requests already running when the device locks (review 2026-10-24)', () => {
  const T = Messages.MessageType
  function answeringKeepKey() {
    const written: number[] = []
    const replies: Array<(b: Uint8Array) => void> = []
    const transport = new Transport(new core.Keyring(), {
      isOpened: async () => true, getDeviceID: async () => 'flow', connect: async () => {}, disconnect: async () => {},
      async writeChunk(buf: Uint8Array) { if (buf[1] === 0x23 && buf[2] === 0x23) written.push((buf[3] << 8) | buf[4]) },
      readChunk: () => new Promise<Uint8Array>((r) => replies.push(r)),
    })
    const answer = (type: number) => { const b = new Uint8Array(64); b.set([0x3f, 0x23, 0x23, type >> 8, type & 0xff, 0, 0, 0, 0]); replies.shift()!(b) }
    return { transport, written, answer }
  }

  test("a multi-message flow's follow-ups still go after the device locks mid-flow; a new request does not", async () => {
    const { transport, written, answer } = answeringKeepKey()
    const state: GateState = { wipeInProgress: false, wipeOnReconnect: false, locked: false }
    gateRestWrites(transport, () => state)
    const t: any = transport
    // hdwallet's signing shape: one lockDuring, every message omitLock (bitcoin.ts, ethereum.ts).
    const flow = restRequest.run({ whileLocked: false }, () => t.lockDuring(async () => {
      await t.call(T.MESSAGETYPE_SIGNTX, new Messages.SignTx(), { omitLock: true, msgTimeout: 2000 })
      state.locked = true // the device asked for its PIN: Desktop now counts it as locked
      await t.call(T.MESSAGETYPE_TXACK, new Messages.TxAck(), { omitLock: true, msgTimeout: 2000 })
    }))
    await tick(); answer(T.MESSAGETYPE_FEATURES)
    await tick(); answer(T.MESSAGETYPE_FEATURES)
    await flow
    expect(written).toEqual([T.MESSAGETYPE_SIGNTX, T.MESSAGETYPE_TXACK])
    const fresh = await restRequest.run({ whileLocked: false }, () =>
      transport.call(T.MESSAGETYPE_GETADDRESS, new Messages.GetAddress(), { msgTimeout: 2000 })).catch((e) => e)
    expect(fresh.status).toBe(423)
    expect(written).toEqual([T.MESSAGETYPE_SIGNTX, T.MESSAGETYPE_TXACK])
  })

  test("what a state change starts is Desktop's, not the REST request's (the PIN auto-prompt timer)", async () => {
    const seen = await restRequest.run({ whileLocked: false }, () => new Promise((resolve) => {
      restRequest.exit(() => setTimeout(() => resolve(restRequest.getStore()), 0))
    }))
    expect(seen).toBeUndefined()
  })
})

describe('wiring', () => {
  const read = (f: string) => readFileSync(path.join(import.meta.dir, '../src/bun', f), 'utf8')
  const rest = read('rest-api.ts')
  const engine = read('engine-controller.ts')

  test('every REST device route is refused while a wipe owns the device or waits for its replug', () => {
    const requireWallet = rest.slice(rest.indexOf('function requireWallet('), rest.indexOf('const KEEPKEY_VENDOR_ID'))
    expect(requireWallet).toContain('engine.wipeInProgress')
    expect(requireWallet).toContain('engine.wipeOnReconnect')
    expect(requireWallet).toContain('409')
  })

  test('the reconnect sends the deferred wipe before any PIN request, only for the same device on a new connection', () => {
    const auto = engine.slice(engine.indexOf('const autoPrompt = (): void => {'))
    const wipeBranch = auto.slice(0, auto.indexOf('this.promptPin()'))
    expect(wipeBranch).toContain('if (this.wipeInProgress) return')
    expect(wipeBranch).toContain('this.wallet !== this.wipeDeferredWallet')
    expect(wipeBranch).toContain('this.cachedFeatures?.deviceId')
    expect(wipeBranch).toContain('this.wipeDevice()')
  })

  test('a PIN request on the deferring connection drops the deferred wipe (needs a new click)', () => {
    const listener = engine.slice(engine.indexOf('transport.on(String(core.Events.PIN_REQUEST)'), engine.indexOf("this.emit('pin-request'"))
    expect(listener).toContain('this.wipeOnReconnect = null')
  })

  test('nothing else talks to the device during a wipe: PIN prompt, syncState, USB attach', () => {
    const promptPin = engine.slice(engine.indexOf('  async promptPin() {'), engine.indexOf('const promise = requestUnlock('))
    expect(promptPin).toContain('this.wipeInProgress')
    const sync = engine.slice(engine.indexOf('  async syncState() {'), engine.indexOf('this.syncing = true'))
    expect(sync).toContain('this.wipeInProgress')
    const attach = engine.slice(engine.indexOf("usb.on('attach'"), engine.indexOf("usb.on('detach'"))
    expect(attach).toContain('this.wipeInProgress')
  })

  test('a locked device: REST seed calls are refused at once; features, wipe, clear-session, PIN entry are not', () => {
    const requireWallet = rest.slice(rest.indexOf('function requireWallet('), rest.indexOf('const KEEPKEY_VENDOR_ID'))
    expect(requireWallet).toContain('if (!whileLocked && engine.isLocked) throw new HttpError(423, DEVICE_LOCKED_MESSAGE)')
    const exempt = (route: string) => rest.slice(rest.indexOf(`'${route}'`), rest.indexOf(`'${route}'`) + 400)
      .includes('requireWallet(engine, { whileLocked: true })')
    for (const route of ['/system/info/get-features', '/system/wipe-device', '/system/clear-session', '/system/recovery/pin']) expect([route, exempt(route)]).toEqual([route, true])
    for (const route of ['/api/pubkeys/batch', '/eth/sign-transaction', '/addresses/utxo']) expect([route, exempt(route)]).toEqual([route, false])
  })

  test('every REST request runs tagged, the wipe runs untagged, and the engine gates the transport', () => {
    expect(rest).toContain('fetch(req, server) { return restRequest.run({ whileLocked: false }, async () => {')
    expect(engine).toContain('await restRequest.exit(() => wipeOwningDevice(')
    expect(engine).toContain('gateRestWrites(transport, () => ({')
    // A PIN prompt the device raises on its own (auto-lock) hands the unlock to Desktop.
    const listener = engine.slice(engine.indexOf('transport.on(String(core.Events.PIN_REQUEST)'), engine.indexOf("this.emit('pin-request'"))
    expect(listener).toContain("if (this.lastState === 'ready' && !this.setupInProgress && !this.verifyInProgress) this.updateState('needs_pin')")
  })

  test("state changes run outside any REST store, and the batch route doesn't turn a refusal into a 200", () => {
    expect(engine).toContain('restRequest.exit(() => this.applyState(state))')
    expect(rest.split('if (err instanceof HttpError) throw err // the device is locked or wiping').length - 1).toBe(2)
  })

  test("the PIN pad is live only while the device asks for the PIN, not during its countdown (hardware test 2026-10-24)", () => {
    const listener = engine.slice(engine.indexOf('transport.on(String(core.Events.PIN_REQUEST)'), engine.indexOf("this.emit('pin-request'") + 40)
    expect(listener).toContain('this.setPinPromptOpen(true)')
    const failures = engine.slice(engine.indexOf('transport.on(core.Events.FAILURE'), engine.indexOf('transport.on(core.Events.FAILURE') + 500)
    expect(failures).toContain('this.setPinPromptOpen(false)')
    const sendPin = engine.slice(engine.indexOf('  async sendPin(pin: string) {'), engine.indexOf('  async sendPin(pin: string) {') + 400)
    expect(sendPin).toContain('this.setPinPromptOpen(false)')
    const app = readFileSync(path.join(import.meta.dir, '../src/mainview/App.tsx'), 'utf8')
    expect(app).toContain('deviceAsking={deviceState.pinPromptOpen ?? true}')
    const pad = readFileSync(path.join(import.meta.dir, '../src/mainview/components/device/PinEntry.tsx'), 'utf8')
    expect(pad).toContain('if (!deviceAsking) return')
    expect(pad).toContain('disabled={pin.length >= 9 || !deviceAsking}')
    expect(pad).toContain('if (pin.length > 0 && deviceAsking)')
  })

  test('REST and UI wipes both go through the engine, never straight to wallet.wipe()', () => {
    const route = rest.slice(rest.indexOf("'/system/wipe-device'"), rest.indexOf("'/system/clear-session'"))
    expect(route).toContain('engine.wipeDevice()')
    expect(route).not.toContain('wallet.wipe()')
    const index = read('index.ts')
    const rpc = index.slice(index.indexOf('wipeDevice: async () =>'), index.indexOf('getPublicKeys: async (params)'))
    expect(rpc).toContain('engine.wipeDevice(')
    expect(rpc).not.toContain('wallet.wipe()')
  })
})
