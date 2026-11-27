import { versionCompare } from './firmware-versions'

export const ZCASH_NU7_BRANCH_ID = 0x77190ad9
export const ZCASH_NU7_ACTIVATION_HEIGHT = 3_543_405
export const ZCASH_NU7_MIN_FIRMWARE = '7.17.0'
export const ZCASH_V6_VERSION_GROUP_ID = 0xd884b698
export const ZCASH_NU7_UNSUPPORTED_MESSAGE = 'Your KeepKey needs firmware 7.17 or later to send Zcash.'

export function zcashNu7SupportError(firmwareVersion: string | undefined, sidecarAvailable = true, admittedAlphaWallet = false): string | undefined {
  if (!admittedAlphaWallet) return ZCASH_NU7_UNSUPPORTED_MESSAGE
  if (!firmwareVersion || !/^v?\d+\.\d+\.\d+$/.test(firmwareVersion)
    || versionCompare(firmwareVersion.replace(/^v/, ''), ZCASH_NU7_MIN_FIRMWARE) < 0) {
    return ZCASH_NU7_UNSUPPORTED_MESSAGE
  }
  if (!sidecarAvailable) return 'This Vault build does not include the Zcash Nu7 transaction builder. Update Vault before sending ZEC.'
  return undefined
}

export function assertZcashNu7Support(firmwareVersion: string | undefined, sidecarAvailable = true, admittedAlphaWallet = false): void {
  const error = zcashNu7SupportError(firmwareVersion, sidecarAvailable, admittedAlphaWallet)
  if (error) throw new Error(error)
}
