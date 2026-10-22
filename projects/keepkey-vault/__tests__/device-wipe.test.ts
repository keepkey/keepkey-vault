/**
 * Wiping a locked KeepKey: the wipe owns the device until it answers.
 *
 * 2026-10-22 (vault-backend.log 17:06:46Z): Cancel ended the PIN prompt, the
 * device showed its wipe confirmation, a REST get-features poll reached the
 * device mid-confirmation ("Unknown message"), the wipe got "Unexpected
 * message" and fell back to the PIN prompt.
 *
 * Run: bun test __tests__/device-wipe.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import * as path from 'path'
import { wipeOwningDevice, WIPE_BUSY_MESSAGE, type WipeHost } from '../src/bun/device-wipe'

/** A locked device whose wipe confirmation stays on screen until `press()`. */
function lockedDevice(outcome: 'confirm' | 'refuse' = 'confirm') {
  const log: string[] = []
  let press!: () => void
  const onScreen = new Promise<void>((resolve) => { press = resolve })
  const host: WipeHost & { reprompts: number } = {
    reprompts: 0,
    wipeInProgress: false,
    repromptPin() { this.reprompts++ },
    wallet: {
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
    await tick()
    // The device is showing the wipe confirmation. This is where the poll broke it.
    expect(host.wipeInProgress).toBe(true)
    await expect(wipeOwningDevice(host, direct, async () => {})).rejects.toThrow(WIPE_BUSY_MESSAGE)
    expect(log).toEqual(['cancel', 'wipe'])
    press()
    await done
    expect(host.wipeInProgress).toBe(false)
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

  test('no device: refused before anything is sent', async () => {
    const host: WipeHost = { wallet: null, wipeInProgress: false, repromptPin() {} }
    await expect(wipeOwningDevice(host, direct, async () => {})).rejects.toThrow('No device connected')
    expect(host.wipeInProgress).toBe(false)
  })
})

describe('wiring', () => {
  const read = (f: string) => readFileSync(path.join(import.meta.dir, '../src/bun', f), 'utf8')
  const rest = read('rest-api.ts')

  test('every REST device route is refused while a wipe owns the device', () => {
    const requireWallet = rest.slice(rest.indexOf('function requireWallet('), rest.indexOf('const KEEPKEY_VENDOR_ID'))
    expect(requireWallet).toContain('engine.wipeInProgress')
    expect(requireWallet).toContain('409')
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
