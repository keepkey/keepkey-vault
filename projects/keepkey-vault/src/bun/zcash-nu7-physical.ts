import { versionCompare } from '../shared/firmware-versions'
import { ZCASH_NU7_MIN_FIRMWARE } from '../shared/zcash-nu7'

/** Exact full-image SHA256 of the physical alpha built from firmware
 * 66df3e24ce5a90dac790e89cc031d3cec82e9d15. This is not a payload hash or
 * an assertion that every firmware reporting version 7.17 supports Nu7. */
export const ZCASH_NU7_PHYSICAL_ALPHA_SHA256 = 'a0275ca76568ace103cbb2daa069f76b0d8d7b5005a3419548a578018eda1808'

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
 * A normal PIN/passphrase transition may keep the same physical wallet; the
 * operation coordinator still owns unlocking and the signing session fence. */
export function isAdmittedNu7PhysicalAlpha(wallet: unknown, state: Nu7PhysicalSnapshot): boolean {
  const version = state.firmwareVersion
  const hash = state.firmwareHash
  return !!wallet && typeof wallet === 'object' && wallet === state.wallet
    && state.isEmulator === false && (state.activeTransport === 'hid' || state.activeTransport === 'webusb')
    && ['ready', 'needs_pin', 'needs_passphrase'].includes(state.state)
    && state.bootloaderMode !== true && state.initialized === true
    && typeof version === 'string' && /^v?\d+\.\d+\.\d+$/.test(version)
    && versionCompare(version.replace(/^v/, ''), ZCASH_NU7_MIN_FIRMWARE) >= 0
    && typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash)
    && hash.toLowerCase() === ZCASH_NU7_PHYSICAL_ALPHA_SHA256
}
