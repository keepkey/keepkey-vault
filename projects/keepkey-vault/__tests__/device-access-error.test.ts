import { describe, expect, test } from 'bun:test'
import { isDeviceBusyError, isLocalDeviceAccessError, retryWhileDeviceBusy, withUnlockRetry } from '../src/shared/device-access-error'

describe('local device admission errors', () => {
  const busy = 'KeepKey is busy with another request. Wait for it to finish, then try again.'
  test.each([
    busy,
    'KeepKey is busy with device setup.',
    'KeepKey is busy: signing a transaction. Try again when it finishes.',
    'KeepKey is busy: a wipe is waiting for confirmation on the device',
    'KeepKey is busy: a wipe is waiting for the device to be unplugged and plugged back in',
    'Too many pending KeepKey requests. Wait for the current request to finish.',
    'Timed out waiting for the KeepKey request. Try again.',
    'KeepKey is locked. Unlock it before requesting new device data.',
    'KeepKey is locked: enter the PIN in KeepKey Desktop, then try again',
    'KeepKey is waiting for its PIN or passphrase: enter it in KeepKey Desktop, then try again',
    'Device access is required; unlock KeepKey to load this account',
    'Unlock KeepKey to load this account',
    'KeepKey is not ready for wallet operations. Finish device setup or reconnect it.',
    'No device connected',
  ])('recognizes the message-only RPC failure: %s', message => {
    expect(isLocalDeviceAccessError(new Error(message))).toBe(true)
    expect(isLocalDeviceAccessError(message)).toBe(true)
  })

  test('uses a numeric device status when one survives transport', () => {
    expect(isLocalDeviceAccessError({ status: 409, message: busy })).toBe(true)
    expect(isLocalDeviceAccessError({ statusCode: 409, message: busy })).toBe(true)
    expect(isLocalDeviceAccessError({ status: 503, message: busy })).toBe(false)
    expect(isLocalDeviceAccessError({ status: 423, message: 'Unlock KeepKey to load this account' })).toBe(true)
  })

  test.each([
    'Balance server busy, try again later',
    'KeepKey balance server is busy',
    'RPC endpoint is locked',
    'Network request timed out',
    `Provider returned an error: ${busy}`,
    `${busy} Server unavailable.`,
    { status: 409, message: 'Conflicting balance request' },
    { status: 423, message: 'Provider account locked' },
    { status: 429, message: 'Rate limit exceeded' },
    { status: 503, message: 'Service unavailable' },
    { message: { code: 409, message: busy } },
    null,
    undefined,
  ])('keeps provider and unrecognized failures visible: %j', error => {
    expect(isLocalDeviceAccessError(error)).toBe(false)
  })
})

describe('waiting out a KeepKey held by another request', () => {
  const busy = 'KeepKey is busy with another request. Wait for it to finish, then try again.'
  const queueFull = 'Too many pending KeepKey requests. Wait for the current request to finish.'
  test('only the two refused-before-dispatch contention messages count as busy', () => {
    for (const message of [busy, queueFull]) {
      expect(isDeviceBusyError(new Error(message))).toBe(true)
      expect(isDeviceBusyError(message)).toBe(true)
    }
    // Needs the user (PIN, setup, wipe) or is not contention at all: never retried.
    for (const message of ['KeepKey is locked. Unlock it before requesting new device data.', 'KeepKey is busy with device setup.',
      'Timed out waiting for the KeepKey request. Try again.', 'No device connected', `Provider returned an error: ${busy}`, 'Swap quote has expired. Review a new quote before signing.'])
      expect(isDeviceBusyError(new Error(message))).toBe(false)
    expect(isDeviceBusyError(null)).toBe(false)
  })

  test('retries a busy refusal until the KeepKey is free', async () => {
    let calls = 0
    const value = await retryWhileDeviceBusy(async () => { if (++calls < 3) throw new Error(busy); return 'built' }, () => true, 1)
    expect(value).toBe('built')
    expect(calls).toBe(3)
  })

  test('any other failure surfaces at once', async () => {
    let calls = 0
    await expect(retryWhileDeviceBusy(async () => { calls++; throw new Error('Insufficient balance') }, () => true, 1)).rejects.toThrow('Insufficient balance')
    expect(calls).toBe(1)
  })

  test('a caller that moved on stops the wait without running again', async () => {
    let calls = 0, current = true
    const waiting = retryWhileDeviceBusy(async () => { calls++; current = false; throw new Error(busy) }, () => current, 1)
    await expect(waiting).rejects.toThrow(busy)
    expect(calls).toBe(1)
  })
})

describe('a locked KeepKey opens the PIN dialog instead of an error', () => {
  const locked = () => Promise.reject(new Error('Unlock KeepKey to load this account'))
  test('unlocks once, then the request runs again and its answer is returned', async () => {
    let unlocks = 0, calls = 0
    const unlock = async () => { unlocks++ }
    const run = () => (++calls === 1 ? locked() : Promise.resolve('0xabc'))
    expect(await withUnlockRetry(run, unlock)).toBe('0xabc')
    expect([unlocks, calls]).toEqual([1, 2])
  })
  test('requests failing together share one dialog', async () => {
    let unlocks = 0
    let release!: () => void
    const unlock = () => { unlocks++; return new Promise<void>(r => { release = r }) }
    const run = (() => { let n = 0; return () => (++n <= 2 ? locked() : Promise.resolve('ok')) })()
    const both = Promise.all([withUnlockRetry(run, unlock), withUnlockRetry(run, unlock)])
    await new Promise(r => setTimeout(r, 0)); release()
    expect(await both).toEqual(['ok', 'ok'])
    expect(unlocks).toBe(1)
  })
  test('other errors pass through without a dialog', async () => {
    let unlocks = 0
    await expect(withUnlockRetry(() => Promise.reject(new Error('No device connected')), async () => { unlocks++ })).rejects.toThrow('No device connected')
    expect(unlocks).toBe(0)
  })
})
