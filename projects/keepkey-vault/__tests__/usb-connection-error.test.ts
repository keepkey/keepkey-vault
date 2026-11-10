import { describe, expect, test } from 'bun:test'
import { usbConnectionErrorKind } from '../src/shared/usb-connection-error'

describe('usbConnectionErrorKind', () => {
  test('access and busy errors mean another app holds the KeepKey', () => {
    for (const raw of ['LIBUSB_ERROR_ACCESS', 'Error: LIBUSB_ERROR_BUSY', 'EACCES: permission denied', 'Unable to claim interface.'])
      expect(usbConnectionErrorKind(raw)).toBe('in-use')
  })
  test('missing-device errors mean it was unplugged', () => {
    for (const raw of ['LIBUSB_ERROR_NO_DEVICE', 'LIBUSB_ERROR_NOT_FOUND', 'The device was disconnected.'])
      expect(usbConnectionErrorKind(raw)).toBe('disconnected')
  })
  test('transfer failures mean it stopped responding', () => {
    for (const raw of ['LIBUSB_ERROR_TIMEOUT', 'LIBUSB_ERROR_PIPE', 'LIBUSB_ERROR_IO', 'transfer timed out'])
      expect(usbConnectionErrorKind(raw)).toBe('not-responding')
  })
  test('anything else stays unknown, including empty input', () => {
    expect(usbConnectionErrorKind('Firmware returned an unexpected message')).toBe('unknown')
    expect(usbConnectionErrorKind(null)).toBe('unknown')
    expect(usbConnectionErrorKind('')).toBe('unknown')
  })
})
