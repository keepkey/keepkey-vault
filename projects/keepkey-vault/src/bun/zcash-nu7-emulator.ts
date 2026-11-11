import emulatorManifest from '../../emulator-bundle/manifest.json'
import { firmwareAtLeast, ZCASH_NU7_EMULATOR_MIN_FIRMWARE } from '../shared/zcash-nu7'

const QUALIFIED_LIBRARIES = new Set(
  Object.values(emulatorManifest.files).map(file => file.sha256),
)

export interface Nu7EmulatorSnapshot {
  wallet: unknown
  isEmulator: boolean
  running: boolean
  alphaFirmware: boolean
  firmwareVersion?: string
  librarySha256: string | null
  /** Verified receipt from the fixed, sealed application bundle, if re-signed. */
  reviewedSourceSha256?: string | null
}

/** Only trusted backend state enters here. Renderer/request flags never do. */
export function isQualifiedNu7AlphaEmulator(wallet: unknown, state: Nu7EmulatorSnapshot): boolean {
  return !!wallet && wallet === state.wallet && state.isEmulator && state.running
    && state.alphaFirmware && emulatorManifest.version === '7.17.0'
    && !!state.librarySha256 && (QUALIFIED_LIBRARIES.has(state.librarySha256)
      || (!!state.reviewedSourceSha256 && QUALIFIED_LIBRARIES.has(state.reviewedSourceSha256)))
    && firmwareAtLeast(state.firmwareVersion, ZCASH_NU7_EMULATOR_MIN_FIRMWARE)
}
