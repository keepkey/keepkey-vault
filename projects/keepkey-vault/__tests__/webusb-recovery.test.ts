/**
 * WebUSB half-open recovery tests.
 *
 * Reproduces the pairing retry loop: a WebUSB device whose close() throws
 * "Can't close device with a pending request" stays `opened`, so every retry
 * hit hdwallet's "cannot connect an already-connected connection". The fix
 * (forceReleaseWebUsb) resets the device to abort the pending transfer, then
 * closes it.
 *
 * Run: bun test __tests__/webusb-recovery.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { forceReleaseWebUsb } from '../src/bun/webusb-recovery'

/** Fake node-usb WebUSBDevice: close() fails while a transfer is pending; reset() aborts it. */
class FakeDevice {
  opened = true
  pendingTransfer: boolean
  closeCalls = 0
  resetCalls = 0
  constructor(pendingTransfer: boolean) { this.pendingTransfer = pendingTransfer }
  async open() { this.opened = true }
  async close() {
    this.closeCalls++
    if (this.pendingTransfer) throw new Error("close error: Error: Can't close device with a pending request")
    this.opened = false
  }
  async reset() {
    this.resetCalls++
    // Aborted transfer's callback lands asynchronously, like libusb's completion queue.
    setTimeout(() => { this.pendingTransfer = false }, 5)
  }
}

/** Same contract as hdwallet-keepkey-nodewebusb TransportDelegate.connect(). */
async function pair(dev: FakeDevice) {
  if (dev.opened) throw new Error('cannot connect an already-connected connection')
  await dev.open()
  return { paired: true }
}

describe('forceReleaseWebUsb', () => {
  test('old behaviour: swallowed close leaves device open, retries loop on already-connected', async () => {
    const dev = new FakeDevice(true)
    for (let i = 0; i < 3; i++) {
      await expect(pair(dev)).rejects.toThrow('already-connected')
      try { await dev.close() } catch (_) {}
    }
    expect(dev.opened).toBe(true)
  })

  test('pending transfer: resets, closes, and the retry pairs', async () => {
    const dev = new FakeDevice(true)
    await expect(pair(dev)).rejects.toThrow('already-connected')

    expect(await forceReleaseWebUsb(dev, 1000, 5)).toBe(true)
    expect(dev.opened).toBe(false)
    expect(dev.resetCalls).toBe(1)

    expect(await pair(dev)).toEqual({ paired: true })
  })

  test('close that succeeds does not reset', async () => {
    const dev = new FakeDevice(false)
    expect(await forceReleaseWebUsb(dev)).toBe(true)
    expect(dev.resetCalls).toBe(0)
    expect(dev.closeCalls).toBe(1)
  })

  test('already-closed device is a no-op', async () => {
    const dev = new FakeDevice(false)
    dev.opened = false
    expect(await forceReleaseWebUsb(dev)).toBe(true)
    expect(dev.closeCalls).toBe(0)
  })

  test('never throws and is bounded when the device cannot be released', async () => {
    const dev = new FakeDevice(true)
    dev.reset = async () => { throw new Error('LIBUSB_ERROR_NOT_FOUND') }
    const t0 = Date.now()
    expect(await forceReleaseWebUsb(dev, 100, 10)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  test('hanging close/reset are bounded by the timeout', async () => {
    const dev = {
      opened: true,
      close: () => new Promise<void>(() => {}),
      reset: () => new Promise<void>(() => {}),
    }
    const t0 = Date.now()
    expect(await forceReleaseWebUsb(dev, 100, 10)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})
