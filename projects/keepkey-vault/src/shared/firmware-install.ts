/**
 * Which firmware a KeepKey has, whether it needs an update, and what installing
 * one does to it. Pure so the engine and the tests run the same code.
 *
 * Two lineages ship: multi-chain (manifest `firmware`) and bitcoin-only
 * (manifest `firmwareBitcoinOnly`). A device is only ever compared against,
 * and offered, its own lineage. Crossing lineages or going to an older version
 * can erase the wallet at the new firmware's first boot, so every install
 * carries a flashWipeReason the user must acknowledge.
 */
import { flashWipeReason, type WipeReason } from './flash-wipe'
import { releaseInfo, versionCompare } from './firmware-versions'
import type { FirmwareBinaryRef, FirmwareManifest } from './types'

export type CoinVariant = 'multi' | 'bitcoin-only'

/** Tags in ONDEVICE_FIRMWARE_HASHES that are official releases. The hash table
 *  also carries unsigned in-house builds (v7.14.0-zcash, ...), which are not. */
export const OFFICIAL_RELEASE_TAG = /^v\d+\.\d+\.\d+(-bitcoin-only)?$/

export interface InstalledFirmware {
  /** Semver without 'v'; null when not installed or not known. */
  version: string | null
  /** true = official release, false = not one, undefined = unknown. */
  verified?: boolean
  /** true = bitcoin-only, false = multi-chain, undefined = unknown. */
  bitcoinOnly?: boolean
  /** Firmware bytes are on flash. */
  present: boolean
  /** A new KeepKey: stock factory firmware (4.0.0, no wallet). In bootloader
   *  mode this is session memory, not tied to the device, so it only shapes the
   *  setup UI (picker, Multi-chain default). It never removes a wipe reason. */
  factory?: boolean
}

export interface ChannelFirmware {
  firmware?: FirmwareBinaryRef
  firmwareBitcoinOnly?: FirmwareBinaryRef
}

/** Stock factory firmware: 4.0.0 with no wallet on it. */
export function isFactoryFirmware(version: string, initialized: boolean | undefined): boolean {
  return version === '4.0.0' && initialized === false
}

/** Installed firmware of a device in firmware mode, from its Features. */
export function installedInFirmwareMode(p: { version: string; verified?: boolean; bitcoinOnly: boolean; initialized?: boolean }): InstalledFirmware {
  return {
    version: p.version === '0.0.0' ? null : p.version,
    verified: p.verified,
    bitcoinOnly: p.bitcoinOnly,
    present: true,
    factory: isFactoryFirmware(p.version, p.initialized) || undefined,
  }
}

/**
 * Installed firmware of a device in bootloader mode, which reports only the
 * full-file hash of that firmware. The release table names it (version and
 * variant). Otherwise a firmware-mode snapshot with the same hash fills in what
 * it saw. Anything else stays unknown: never guess multi-chain.
 */
export function installedFromBootloader(p: {
  hashHex?: string
  release: string | null
  snapshot: { version: string | null; bitcoinOnly: boolean } | null
  /** This device was seen on factory firmware before entering bootloader mode. */
  factorySeen?: boolean
}): InstalledFirmware {
  const present = !!p.hashHex && !/^0+$/.test(p.hashHex)
  if (!present) return { version: null, present: false }
  const info = p.release ? releaseInfo(p.release) : null
  if (info) {
    return { version: info.version, verified: OFFICIAL_RELEASE_TAG.test(p.release!), bitcoinOnly: info.bitcoinOnly, present }
  }
  if (p.snapshot) {
    // The snapshot names version and variant, but only the release table says
    // a build is official (as verifyHashes does in firmware mode), so this one
    // is not: an official install over it crosses the signed/unsigned line.
    const v = p.snapshot.version
    return { version: v && v !== '0.0.0' ? v : null, verified: false, bitcoinOnly: p.snapshot.bitcoinOnly, present }
  }
  return { version: null, present, factory: p.factorySeen || undefined }
}

/** Latest version (no 'v') of the lineage a device belongs to. */
export function latestFor(channel: ChannelFirmware | null | undefined, bitcoinOnly: boolean | undefined, fallbackMulti?: string): string | undefined {
  const ref = bitcoinOnly === true ? channel?.firmwareBitcoinOnly : channel?.firmware
  return ref?.version.replace(/^v/, '') ?? (bitcoinOnly === true ? undefined : fallbackMulti)
}

/**
 * Whether to send the device through the firmware update.
 * - Factory firmware, no firmware, or firmware Desktop cannot identify: yes.
 * - Otherwise only when older than the latest of ITS OWN lineage. A
 *   bitcoin-only device with no bitcoin-only build to offer is left alone:
 *   multi-chain firmware is never an "update" for it.
 */
export function needsFirmware(p: {
  bootloaderMode: boolean
  /** Firmware-mode version; ignored in bootloader mode. */
  fwVersion?: string
  installed: InstalledFirmware
  latestMulti?: string
  latestBitcoinOnly?: string
}): boolean {
  let current: string
  if (p.bootloaderMode) {
    if (!p.installed.present || !p.installed.version) return true
    current = p.installed.version
  } else {
    if (!p.fwVersion) return false
    if (p.fwVersion === '4.0.0') return true
    current = p.fwVersion
  }
  const latest = p.installed.bitcoinOnly === true ? p.latestBitcoinOnly : p.latestMulti
  if (!latest) return false
  return versionCompare(current, latest) < 0
}

export type InstallPlan =
  | { ok: true; bitcoinOnly: boolean; version: string; entry?: FirmwareBinaryRef; wipeReason?: WipeReason }
  | { ok: false; error: string }

/**
 * What installing the official firmware would do.
 * `choice` is the user's explicit pick; without one the device keeps its own
 * lineage. A device whose lineage is unknown (unrecognised firmware, no
 * snapshot) must be given a choice: Desktop does not pick one for it.
 */
export function planInstall(p: {
  installed: InstalledFirmware
  choice?: CoinVariant
  channel: ChannelFirmware | null | undefined
  /** Multi-chain version to install when there is no manifest entry. */
  fallbackMulti?: string
}): InstallPlan {
  let bitcoinOnly: boolean | undefined = p.choice ? p.choice === 'bitcoin-only' : p.installed.bitcoinOnly
  // Nothing on flash, or a new KeepKey: multi-chain unless the user chose.
  if (bitcoinOnly === undefined && (!p.installed.present || p.installed.factory === true)) bitcoinOnly = false
  if (bitcoinOnly === undefined) {
    return { ok: false, error: 'KeepKey Desktop cannot tell which firmware is on this KeepKey. Choose Bitcoin-only or Multi-chain firmware first.' }
  }
  const entry = bitcoinOnly ? p.channel?.firmwareBitcoinOnly : p.channel?.firmware
  if (bitcoinOnly && !entry) {
    return { ok: false, error: 'Bitcoin-only firmware is not available in this build.' }
  }
  const version = entry ? entry.version.replace(/^v/, '') : p.fallbackMulti
  if (!version) return { ok: false, error: 'No firmware release is available to install.' }
  // Every device gets the same check, new ones included: "new" can be session
  // memory (factory), and a device with no firmware may still hold a wallet.
  const wipeReason = flashWipeReason({
    isSigned: true,
    currentFirmwareVerified: p.installed.verified,
    isDowngrade: !!p.installed.version && versionCompare(version, p.installed.version) < 0,
    currentBitcoinOnly: p.installed.bitcoinOnly,
    targetBitcoinOnly: bitcoinOnly,
    installedUnknown: p.installed.present && !p.installed.version,
    noFirmware: !p.installed.present,
  })
  return { ok: true, bitcoinOnly, version, entry, wipeReason }
}

/**
 * The engine's gate before anything is erased: the plan must be valid, and a
 * plan that may wipe or lock the wallet needs the user's acknowledgement of
 * that exact reason (not a reason shown earlier for another plan).
 */
export function assertInstallAllowed(plan: InstallPlan, acknowledgeWipe?: WipeReason): asserts plan is Extract<InstallPlan, { ok: true }> {
  if (!plan.ok) throw new Error(plan.error)
  if (plan.wipeReason && acknowledgeWipe !== plan.wipeReason) throw new Error(`WIPE_ACK_REQUIRED:${plan.wipeReason}`)
}

/** Only the bitcoin-only build compiles in "KeepKeyBTC"/"EmulatorBTC"
 *  (fsm_msg_common.h, under #if BITCOIN_ONLY); a multi-chain build never does. */
export function isBitcoinOnlyImage(bytes: ArrayBufferView): boolean {
  const text = new TextDecoder('latin1').decode(bytes)
  return text.includes('KeepKeyBTC') || text.includes('EmulatorBTC')
}

/**
 * The setup wizard's Bitcoin-only / Multi-chain choice.
 * - A Bitcoin-only device stays Bitcoin-only: no picker.
 * - A new KeepKey, or one going through setup's bootloader update, gets the
 *   picker with Multi-chain preselected, or the choice the user already made
 *   (it outlives the bootloader-update replugs). Other multi-chain devices
 *   update as before, with no picker.
 * - A device whose firmware Desktop cannot identify gets the picker with
 *   nothing preselected: the user must choose.
 * - No picker when the flag is off or there is no bitcoin-only build.
 */
export function wizardCoinMode(p: {
  enabled: boolean
  bitcoinOnlyAvailable: boolean
  installedBitcoinOnly?: boolean
  /** deviceStatus.factoryFirmware: factory firmware, or no firmware. */
  newDevice: boolean
  /** The device needs the bootloader update (setup's first page). */
  needsBootloaderUpdate: boolean
  remembered: CoinVariant | null
}): { coinMode: CoinVariant | null; showPicker: boolean; variantUnknown: boolean } {
  const variantUnknown = !p.newDevice && p.installedBitcoinOnly === undefined
  if (p.installedBitcoinOnly === true) return { coinMode: 'bitcoin-only', showPicker: false, variantUnknown }
  if (!p.enabled || !p.bitcoinOnlyAvailable) return { coinMode: 'multi', showPicker: false, variantUnknown }
  if (variantUnknown) return { coinMode: p.remembered, showPicker: true, variantUnknown }
  const showPicker = p.newDevice || p.needsBootloaderUpdate || p.remembered !== null
  return { coinMode: showPicker ? p.remembered ?? 'multi' : 'multi', showPicker, variantUnknown }
}

/**
 * Setup's page after the authenticity check: the firmware choice, before the
 * tutorial, for a device that gets one. Without features every device looks
 * unidentified, so then it goes on to the tutorial (the bootloader and
 * firmware pages still link to the choice).
 */
export function stepAfterAuthenticity(p: { showPicker: boolean; hasFeatures: boolean }): 'coin-choice' | 'intro' {
  return p.showPicker && p.hasFeatures ? 'coin-choice' : 'intro'
}

/**
 * Merge the bundled and remote manifests. Per channel the newer multi-chain
 * entry wins (bundled on ties: it ships inside the signed app), and the
 * bitcoin-only build is picked separately on its own version, so it is never
 * dropped because the multi-chain entry came from the other side.
 */
export function mergeManifests(bundled: FirmwareManifest | null, remote: FirmwareManifest | null): FirmwareManifest | null {
  if (!bundled || !remote) return bundled ?? remote
  const older = (a: { version: string }, b: { version: string }) =>
    versionCompare(a.version.replace(/^v/, ''), b.version.replace(/^v/, '')) < 0
  const newerRef = (b?: FirmwareBinaryRef, r?: FirmwareBinaryRef) => !b ? r : !r ? b : older(b, r) ? r : b
  const pick = (b: FirmwareManifest['latest'], r: FirmwareManifest['latest']): FirmwareManifest['latest'] => {
    const { firmwareBitcoinOnly: _drop, ...multi } = older(b.firmware, r.firmware) ? r : b
    const firmwareBitcoinOnly = newerRef(b.firmwareBitcoinOnly, r.firmwareBitcoinOnly)
    return firmwareBitcoinOnly ? { ...multi, firmwareBitcoinOnly } : multi
  }
  return {
    latest: pick(bundled.latest, remote.latest),
    beta: pick(bundled.beta ?? bundled.latest, remote.beta ?? remote.latest),
    hashes: {
      bootloader: { ...(bundled.hashes?.bootloader ?? {}), ...(remote.hashes?.bootloader ?? {}) },
      firmware: { ...(bundled.hashes?.firmware ?? {}), ...(remote.hashes?.firmware ?? {}) },
    },
  }
}
