/**
 * Recovery for a half-open WebUSB device.
 *
 * node-usb's WebUSBDevice.close() throws "Can't close device with a pending
 * request" while a transferIn is still outstanding (e.g. the old wallet was
 * dropped while the device sat on a PIN prompt). `opened` then stays true, and
 * because node-usb caches WebUSBDevice objects, every pairing retry gets the
 * same half-open device and hdwallet's connect() throws "cannot connect an
 * already-connected connection" forever — only a replug recovered.
 *
 * libusb_reset_device (WebUSBDevice.reset()) aborts the pending transfers, so
 * after a reset the close can go through.
 */

export interface ReleasableWebUsbDevice {
  readonly opened: boolean
  close(): Promise<void>
  reset(): Promise<void>
}

const errMsg = (err: any) => err?.message || String(err)

function bounded<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  p.catch(() => {})
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer!))
}

/**
 * Close the device; if it stays open, reset it (aborting pending transfers)
 * and keep retrying close until `timeoutMs`. Never throws.
 * Returns true when the device ends up closed.
 */
export async function forceReleaseWebUsb(
  dev: ReleasableWebUsbDevice,
  timeoutMs = 3000,
  retryDelayMs = 100,
): Promise<boolean> {
  if (!dev.opened) return true
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(1, deadline - Date.now())

  try {
    await bounded(dev.close(), remaining(), 'WebUSB close')
  } catch (err) {
    console.warn('[Engine] WebUSB close failed:', errMsg(err))
  }
  if (!dev.opened) return true

  console.warn('[Engine] WebUSB device still open (pending transfer?) — resetting to abort it')
  try {
    await bounded(dev.reset(), remaining(), 'WebUSB reset')
  } catch (err) {
    console.warn('[Engine] WebUSB reset failed:', errMsg(err))
  }

  // Aborted transfers complete asynchronously; retry close until they drain.
  let lastErr: unknown = null
  while (dev.opened && Date.now() < deadline) {
    try {
      await bounded(dev.close(), remaining(), 'WebUSB close')
    } catch (err) {
      lastErr = err
    }
    if (dev.opened) await new Promise(r => setTimeout(r, retryDelayMs))
  }

  if (dev.opened) {
    console.warn('[Engine] WebUSB device could not be released:', lastErr ? errMsg(lastErr) : 'still open')
    return false
  }
  console.log('[Engine] WebUSB device released after reset')
  return true
}
