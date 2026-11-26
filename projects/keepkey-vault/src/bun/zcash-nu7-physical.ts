import { versionCompare } from '../shared/firmware-versions'
import { ZCASH_NU7_MIN_FIRMWARE } from '../shared/zcash-nu7'

export interface Nu7PhysicalSnapshot {
  wallet: unknown
  isEmulator: boolean
  activeTransport?: string | null
  state: string
  bootloaderMode?: boolean
  initialized?: boolean
  firmwareVersion?: string
  firmwareHash?: string
}

/** Native engine state only. Renderer flags and version labels grant nothing.
 * Any firmware >= ZCASH_NU7_MIN_FIRMWARE supports Nu7; no image hash pin.
 * A normal PIN/passphrase transition may keep the same physical wallet; the
 * operation coordinator still owns unlocking and the signing session fence. */
export function isAdmittedNu7PhysicalAlpha(wallet: unknown, state: Nu7PhysicalSnapshot): boolean {
  const version = state.firmwareVersion
  return !!wallet && typeof wallet === 'object' && wallet === state.wallet
    && state.isEmulator === false && (state.activeTransport === 'hid' || state.activeTransport === 'webusb')
    && ['ready', 'needs_pin', 'needs_passphrase'].includes(state.state)
    && state.bootloaderMode !== true && state.initialized === true
    && typeof version === 'string' && /^v?\d+\.\d+\.\d+$/.test(version)
    && versionCompare(version.replace(/^v/, ''), ZCASH_NU7_MIN_FIRMWARE) >= 0
}
