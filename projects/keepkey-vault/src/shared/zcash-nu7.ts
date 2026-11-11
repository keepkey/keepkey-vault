import { versionCompare } from './firmware-versions'
import { isBitcoinOnlyVariant } from './flags'

export const ZCASH_NU7_BRANCH_ID = 0x77190ad9
export const ZCASH_NU7_ACTIVATION_HEIGHT = 3_543_405
/** Released firmware whose ZcashSignPCZT signs NU7 transparent v6 payments
 *  (firmware audit 2026-11-10, tag v7.16.0 / 4f94a63b). */
export const ZCASH_NU7_PHYSICAL_MIN_FIRMWARE = '7.16.0'
/** The reviewed bundled alpha emulator. */
export const ZCASH_NU7_EMULATOR_MIN_FIRMWARE = '7.17.0'
export const ZCASH_V6_VERSION_GROUP_ID = 0xd884b698

export type ZcashNu7Route = 'physical' | 'alpha-emulator'
export type ZcashNu7Refusal = 'firmware' | 'emulator' | 'variant' | 'device' | 'builder'

/** SendForm shows the same copy (as literal, translatable strings). */
export const ZCASH_NU7_REFUSALS: Readonly<Record<ZcashNu7Refusal, string>> = {
  firmware: 'Sending ZEC needs KeepKey firmware 7.16 or newer. Update it from Settings (opt in to new firmware).',
  emulator: 'Sending ZEC from the emulator needs the reviewed 7.17 alpha emulator with Alpha Firmware turned on in Settings.',
  variant: 'Bitcoin-only firmware cannot send ZEC.',
  device: 'Could not confirm that this KeepKey can send ZEC. Reconnect it and try again.',
  builder: 'Update KeepKey Desktop to send ZEC. This build is missing the Zcash transaction builder.',
}

/** What the host itself read from the KeepKey: its Features (transport,
 *  version, variant, mode) and, for the emulator, the loaded library's verified
 *  provenance. Request bodies, renderer flags and labels never enter here. */
export interface ZcashNu7Device {
  transport: string | null | undefined
  firmwareVersion?: string
  firmwareVariant?: string
  bootloaderMode?: boolean
  initialized?: boolean
  qualifiedAlphaEmulator?: boolean
}

export type ZcashNu7Admission = { route: ZcashNu7Route } | { refusal: ZcashNu7Refusal; reason: string }

const PHYSICAL_TRANSPORTS = new Set(['webusb', 'hid'])

export function firmwareAtLeast(version: string | undefined, minimum: string): boolean {
  return !!version && /^v?\d+\.\d+\.\d+$/.test(version) && versionCompare(version.replace(/^v/, ''), minimum) >= 0
}

/** Transparent NU7 sends: a physical KeepKey on 7.16.0+, or the reviewed 7.17
 *  alpha emulator. Everything else is refused before the device is acquired. */
export function zcashNu7Admission(device: ZcashNu7Device, builderAvailable = true): ZcashNu7Admission {
  const refuse = (refusal: ZcashNu7Refusal): ZcashNu7Admission => ({ refusal, reason: ZCASH_NU7_REFUSALS[refusal] })
  let route: ZcashNu7Route
  if (device.transport === 'emulator') {
    if (!device.qualifiedAlphaEmulator || !firmwareAtLeast(device.firmwareVersion, ZCASH_NU7_EMULATOR_MIN_FIRMWARE)) return refuse('emulator')
    route = 'alpha-emulator'
  } else if (device.transport && PHYSICAL_TRANSPORTS.has(device.transport)) {
    // In bootloader mode the reported version is the bootloader's.
    if (device.bootloaderMode || device.initialized === false) return refuse('device')
    if (isBitcoinOnlyVariant(device.firmwareVariant)) return refuse('variant')
    if (!firmwareAtLeast(device.firmwareVersion, ZCASH_NU7_PHYSICAL_MIN_FIRMWARE)) return refuse('firmware')
    route = 'physical'
  } else {
    return refuse('device')
  }
  return builderAvailable ? { route } : refuse('builder')
}

export const ZCASH_SHIELDED_NU7_REFUSAL = 'Shielding, unshielding and private sends are not available on the Zcash NU7 network upgrade yet. KeepKey firmware needs an update to sign them. Nothing was sent, and your shielded balance is unchanged. Transparent ZEC sends work with firmware 7.16 or newer.'

/** Released 7.16 firmware and the 7.17 alpha admit Ironwood and pool-crossing
 *  (migration) bundles only under NU6.3. Once the chain has reached NU7, every
 *  shielded build would carry the NU7 branch, so refuse before the device or a
 *  proof is touched. Unknown height: the sidecar refuses on the node's branch,
 *  still before any proof. */
export function zcashShieldedNu7Refusal(chainHeight: number | null | undefined): string | undefined {
  return typeof chainHeight === 'number' && Number.isSafeInteger(chainHeight)
    && chainHeight + 1 >= ZCASH_NU7_ACTIVATION_HEIGHT ? ZCASH_SHIELDED_NU7_REFUSAL : undefined
}
