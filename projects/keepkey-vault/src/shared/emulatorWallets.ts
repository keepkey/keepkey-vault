import type { EmulatorWalletInfo } from './types'

/** Why a name cannot be used for a new emulator wallet, or null when it can. */
export function newEmulatorWalletNameError(name: string, existing: string[]): string | null {
  const n = name.trim()
  if (!n) return 'Name the wallet'
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(n)) return 'Use lowercase letters, digits and dashes (max 32)'
  if (n.startsWith('build-')) return '"build-" names belong to emulator builds'
  // Case-insensitive: the default macOS and Windows filesystems are.
  if (existing.some((e) => e.toLowerCase() === n)) return `"${n}" already exists`
  return null
}

/** One line that tells two emulator wallets apart: what the device calls
 * itself, its firmware, the end of its device id and when it last ran. */
export function emulatorWalletDetail(w: EmulatorWalletInfo, now = Date.now()): string {
  if (!w.deviceId) return 'never started'
  const hours = w.lastUsed ? Math.floor((now - w.lastUsed) / 3_600_000) : undefined
  return [
    w.label && `label "${w.label}"`,
    w.firmwareVersion && `fw ${w.firmwareVersion}`,
    `id …${w.deviceId.slice(-6)}`,
    hours === undefined ? '' : hours < 1 ? 'used this hour' : hours < 48 ? `used ${hours}h ago` : `used ${Math.floor(hours / 24)}d ago`,
  ].filter(Boolean).join(' · ')
}

/** How an emulator firmware build is named everywhere: version, then what it is.
 *  "v7.17.0 · Monero signing (research)", "v7.16.0 · build 249bcff13435". */
export function emulatorBuildTitle(build: { id?: string | null; version?: string; label?: string }): string {
  const version = build.version ? `v${build.version}` : ''
  if (!build.id) return [version, 'bundled emulator'].filter(Boolean).join(' · ')
  const what = build.label || `build ${build.id.slice(0, 12)}`
  return version ? `${version} · ${what}` : `Unverified ${what}`
}
