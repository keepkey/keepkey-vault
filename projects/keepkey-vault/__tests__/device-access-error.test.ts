import { describe, expect, test } from 'bun:test'
import { isLocalDeviceAccessError } from '../src/shared/device-access-error'

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
