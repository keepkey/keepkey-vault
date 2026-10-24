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

describe('wiring', () => {
  const read = (f: string) => readFileSync(path.join(import.meta.dir, '../src/bun', f), 'utf8')
  const rest = read('rest-api.ts')
  const engine = read('engine-controller.ts')

  test('every REST device route is refused while a wipe owns the device or waits for its replug', () => {
    const requireWallet = rest.slice(rest.indexOf('async function requireWallet('), rest.indexOf('const KEEPKEY_VENDOR_ID'))
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

  test('a locked device: REST seed calls wait for Desktop to unlock it; features, wipe, PIN entry do not', () => {
    // Hardware test 2026-10-24: a REST batch request between PIN retries asked for the PIN
    // itself, and one sent during the countdown timed out after 5 s and closed the connection.
    const requireWallet = rest.slice(rest.indexOf('async function requireWallet('), rest.indexOf('const KEEPKEY_VENDOR_ID'))
    expect(requireWallet).toMatch(/if \(!whileLocked && engine\.isLocked\) \{\s*await engine\.waitUntilUnlocked\(/)
    // every call site awaits the wait (the one other occurrence is the definition)
    expect(rest.split('await requireWallet(engine').length).toBe(rest.split('requireWallet(engine').length - 1)
    const exempt = (route: string) => {
      const body = rest.slice(rest.indexOf(`'${route}'`), rest.indexOf(`'${route}'`) + 400)
      return body.includes('requireWallet(engine, { whileLocked: true })')
    }
    for (const route of ['/system/info/get-features', '/system/wipe-device', '/system/clear-session', '/system/recovery/pin']) expect([route, exempt(route)]).toEqual([route, true])
    for (const route of ['/api/pubkeys/batch', '/eth/sign-transaction', '/addresses/utxo']) expect([route, exempt(route)]).toEqual([route, false])
    const wait = engine.slice(engine.indexOf('  waitUntilUnlocked('), engine.indexOf('  waitUntilUnlocked(') + 600)
    expect(wait).toContain("this.on('state-change'")
    expect(wait).toContain("this.off('state-change'")
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
