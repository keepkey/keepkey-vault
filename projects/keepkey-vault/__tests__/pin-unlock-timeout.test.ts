/**
 * PIN unlock must outlast the firmware's post-failure lockout wait.
 *
 * After 3+ failed PINs, firmware pin_protect() shows
 * "Previous PIN Failures: Wait N seconds" (N = 2^fails) BEFORE it sends
 * PinMatrixRequest. The unlock request therefore must use LONG_TIMEOUT, not
 * hdwallet's 5 s DEFAULT_TIMEOUT, and a timeout on this path must reach the
 * user instead of silently reshowing the PIN grid.
 *
 * Run: bun test __tests__/pin-unlock-timeout.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import * as path from 'path'
import * as core from '@keepkey/hdwallet-core'
import * as Messages from '@keepkey/device-protocol/lib/messages_pb'
import { TransportTimeoutError } from '@keepkey/hdwallet-keepkey/dist/transport'
import { requestUnlock, isTransportTimeout, UNLOCK_ADDRESS_N } from '../src/bun/pin-unlock'

// Firmware lockout wait (seconds) before PinMatrixRequest, per pin_sm.c.
const lockoutWaitMs = (fails: number) => (fails > 2 ? 2 ** fails * 1000 : 0)

describe('requestUnlock', () => {
  test('sends GetPublicKey with LONG_TIMEOUT, not DEFAULT_TIMEOUT', async () => {
    const calls: any[] = []
    await requestUnlock({ call: async (type, msg, opts) => { calls.push({ type, msg, opts }) } })

    expect(calls).toHaveLength(1)
    const { type, msg, opts } = calls[0]
    expect(type).toBe(Messages.MessageType.MESSAGETYPE_GETPUBLICKEY)
    expect(msg.getShowDisplay()).toBe(false)
    expect(msg.getAddressNList()).toEqual(UNLOCK_ADDRESS_N)
    expect(msg.getCoinName()).toBe('Bitcoin')
    expect(opts.msgTimeout).toBe(core.LONG_TIMEOUT)
    expect(opts.msgTimeout).toBeGreaterThan(core.DEFAULT_TIMEOUT)
  })

  test('timeout outlasts the lockout wait for 3..8 prior failures', () => {
    // DEFAULT_TIMEOUT (the old behaviour) already loses at 3 failures (8 s).
    expect(core.DEFAULT_TIMEOUT).toBeLessThan(lockoutWaitMs(3))
    for (let fails = 3; fails <= 8; fails++) {
      expect(core.LONG_TIMEOUT).toBeGreaterThan(lockoutWaitMs(fails))
    }
  })

  test("recognises hdwallet's TransportTimeoutError", () => {
    expect(isTransportTimeout(new TransportTimeoutError('device response', 5000))).toBe(true)
    expect(isTransportTimeout(new Error('Invalid PIN'))).toBe(false)
    expect(isTransportTimeout(undefined)).toBe(false)
  })
})

describe('engine-controller wiring', () => {
  const src = readFileSync(path.join(import.meta.dir, '../src/bun/engine-controller.ts'), 'utf8')
  const promptPinBody = src.slice(src.indexOf('async promptPin()'), src.indexOf('async sendPin('))

  test('promptPin uses requestUnlock, not the 5 s getPublicKeys', () => {
    expect(promptPinBody).toContain('requestUnlock(this.wallet.transport)')
    expect(promptPinBody).not.toContain('this.wallet.getPublicKeys(')
  })

  test('auto prompt-pin surfaces a timeout instead of silently retrying', () => {
    const start = src.indexOf("if (state === 'needs_pin')")
    const block = src.slice(start, src.indexOf("if (state === 'needs_passphrase')", start))
    expect(block).toMatch(/isTransportTimeout\(err\)[\s\S]*?this\.lastError = UNLOCK_TIMEOUT_MESSAGE[\s\S]*?this\.updateState\('error'\)/)
  })
})
