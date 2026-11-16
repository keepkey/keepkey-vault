import { versionCompare } from './firmware-versions'

export const ZCASH_NU7_BRANCH_ID = 0x77190ad9
export const ZCASH_NU7_ACTIVATION_HEIGHT = 3_543_405
export const ZCASH_NU7_MIN_FIRMWARE = '7.17.0'
export const ZCASH_V6_VERSION_GROUP_ID = 0xd884b698

export function zcashNu7SupportError(firmwareVersion: string | undefined, sidecarAvailable = true, isAlphaEmulator = false): string | undefined {
  if (!isAlphaEmulator) return 'Zcash sending requires the 7.17 alpha emulator; physical support is not yet available.'
  if (!firmwareVersion || !/^v?\d+\.\d+\.\d+$/.test(firmwareVersion)
    || versionCompare(firmwareVersion.replace(/^v/, ''), ZCASH_NU7_MIN_FIRMWARE) < 0) {
    return `Zcash Nu7 transparent sends require KeepKey firmware ${ZCASH_NU7_MIN_FIRMWARE} or later. Update your KeepKey before sending ZEC.`
  }
  if (!sidecarAvailable) return 'This Vault build does not include the Zcash Nu7 transaction builder. Update Vault before sending ZEC.'
  return undefined
}

export function assertZcashNu7Support(firmwareVersion: string | undefined, sidecarAvailable = true, isAlphaEmulator = false): void {
  const error = zcashNu7SupportError(firmwareVersion, sidecarAvailable, isAlphaEmulator)
  if (error) throw new Error(error)
}
