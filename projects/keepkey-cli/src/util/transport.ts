/**
 * Dual-transport factory — tries WebUSB first, falls back to HID.
 * Mirrors the pattern from vault's engine-controller.ts.
 */
import * as core from '@keepkey/hdwallet-core'
import { HIDKeepKeyAdapter } from '@keepkey/hdwallet-keepkey-nodehid'
import { NodeWebUSBKeepKeyAdapter } from '@keepkey/hdwallet-keepkey-nodewebusb'

const PAIR_TIMEOUT_MS = 10_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer!))
}

export type TransportType = 'webusb' | 'hid'

export interface ConnectResult {
  wallet: core.HDWallet & Record<string, any>
  transport: TransportType
}

/**
 * Connect to a KeepKey device. Tries WebUSB then HID.
 * Returns the paired wallet and which transport succeeded.
 */
export async function connectDevice(): Promise<ConnectResult> {
  const keyring = new core.Keyring()
  const webUsbAdapter = NodeWebUSBKeepKeyAdapter.useKeyring(keyring)
  const hidAdapter = HIDKeepKeyAdapter.useKeyring(keyring)

  // Try WebUSB first
  try {
    const device = await webUsbAdapter.getDevice().catch(() => undefined)
    if (device) {
      const wallet = await withTimeout(
        webUsbAdapter.pairRawDevice(device),
        PAIR_TIMEOUT_MS,
        'WebUSB pairRawDevice',
      )
      if (wallet) return { wallet: wallet as any, transport: 'webusb' }
    }
  } catch (err: any) {
    // WebUSB failed, fall through to HID
  }

  // Fallback to HID
  try {
    const device = await hidAdapter.getDevice().catch(() => undefined)
    if (device) {
      const wallet = await withTimeout(
        hidAdapter.pairRawDevice(device),
        PAIR_TIMEOUT_MS,
        'HID pairRawDevice',
      )
      if (wallet) return { wallet: wallet as any, transport: 'hid' }
    }
  } catch (err: any) {
    // HID also failed
  }

  throw new Error('No KeepKey device found. Is it plugged in?')
}
