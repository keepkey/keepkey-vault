import * as path from 'path'
import { versionCompare } from '../shared/firmware-versions'

/**
 * Up to 1.6.10 the macOS DMG shipped the app as `keepkey-vault.app`. From then
 * on it ships as `KeepKey Vault.app`, so dragging the new DMG into
 * Applications leaves the old copy beside the new one. On launch from the new
 * name, offer once to move the old copy to the Trash.
 *
 * Wallet data, settings and logs live in
 * ~/Library/Application Support/com.keepkey.vault, outside the app bundle, so
 * trashing the old bundle keeps them.
 */

export const LEGACY_BUNDLE_NAME = 'keepkey-vault.app'
export const CURRENT_BUNDLE_NAME = 'KeepKey Vault.app'
export const BUNDLE_IDENTIFIER = 'com.keepkey.vault'
/** Set to '1' when the user chose to keep the old copy; we don't ask again. */
export const KEEP_LEGACY_SETTING = 'legacy_app_cleanup_declined'

export interface LegacyCleanupDialog {
  type: 'question' | 'error'
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
}

export interface LegacyCleanupDeps {
  platform: string
  /** process.execPath: <bundle>.app/Contents/MacOS/<binary> on macOS. */
  execPath: string
  homeDir: string
  exists: (p: string) => boolean
  /** Resolves symlinks; throws if the path is missing. */
  realpath: (p: string) => string
  /** CFBundleIdentifier of the bundle at `appPath`, or null if unreadable. */
  bundleIdentifier: (appPath: string) => string | null
  /** CFBundleVersion of the bundle at `appPath`, or null if unreadable. */
  bundleVersion: (appPath: string) => string | null
  getSetting: (key: string) => string | null
  setSetting: (key: string, value: string) => void
  /** Shows a dialog and returns the index of the clicked button. */
  ask: (dialog: LegacyCleanupDialog) => Promise<number>
  /** Moves the path to the Trash; true on success. */
  moveToTrash: (p: string) => boolean
  log: (msg: string) => void
}

export type LegacyCleanupResult =
  | 'not-applicable'
  | 'already-declined'
  | 'none-found'
  | 'trashed'
  | 'kept'
  | 'trash-failed'

/** The running .app bundle, or null when not running from one. */
export function runningBundlePath(execPath: string): string | null {
  const bundle = path.resolve(path.dirname(execPath), '..', '..')
  return bundle.endsWith('.app') ? bundle : null
}

/** Old copies to offer for removal: same bundle id, old name, installed in an
 *  Applications folder, not the app that is running, and not newer than it
 *  (an old-named copy the user kept launching may have auto-updated past it). */
export function findLegacyCopies(deps: LegacyCleanupDeps): string[] {
  if (deps.platform !== 'darwin') return []
  const running = runningBundlePath(deps.execPath)
  if (!running || path.basename(running) !== CURRENT_BUNDLE_NAME) return []

  const appFolders = ['/Applications', path.join(deps.homeDir, 'Applications')]
  // Only clean up when the new copy is itself installed. Run straight from the
  // DMG, the old copy may still be the only installed one.
  if (!appFolders.includes(path.dirname(running))) return []

  let runningReal: string
  try { runningReal = deps.realpath(running) } catch { return [] }

  const found: string[] = []
  const seen = new Set<string>()
  for (const folder of appFolders) {
    const candidate = path.join(folder, LEGACY_BUNDLE_NAME)
    if (!deps.exists(candidate)) continue
    let real: string
    try { real = deps.realpath(candidate) } catch { continue }
    if (real === runningReal || seen.has(real)) continue
    seen.add(real)
    if (deps.bundleIdentifier(candidate) !== BUNDLE_IDENTIFIER) {
      deps.log(`[legacy-app] ${candidate} is not ${BUNDLE_IDENTIFIER}; leaving it alone`)
      continue
    }
    const oldVersion = deps.bundleVersion(candidate)
    const runningVersion = deps.bundleVersion(running)
    if (oldVersion && runningVersion && versionCompare(oldVersion, runningVersion) > 0) {
      deps.log(`[legacy-app] ${candidate} (${oldVersion}) is newer than this copy (${runningVersion}); leaving it alone`)
      continue
    }
    found.push(candidate)
  }
  return found
}

export function legacyCleanupDialog(copies: string[]): LegacyCleanupDialog {
  const where = copies.length === 1
    ? `It is at ${copies[0]}.`
    : `Copies are at ${copies.join(' and ')}.`
  return {
    type: 'question',
    message: 'You have two copies of KeepKey Vault installed',
    detail: `The app is now named "KeepKey Vault" (it was "keepkey-vault"). The copy named "keepkey-vault" is from before the rename and isn't needed. ${where}\n\nMove it to the Trash? Your wallets and settings are not stored in the app and will be kept.`,
    buttons: ['Move to Trash', 'Keep It'],
    defaultId: 0,
    cancelId: 1,
  }
}

export function trashFailedDialog(failed: string[]): LegacyCleanupDialog {
  return {
    type: 'error',
    message: 'The older copy could not be moved to the Trash',
    detail: `Drag ${failed.join(' and ')} to the Trash in Finder. Your wallets and settings will be kept.`,
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
  }
}

/** Offers to trash old `keepkey-vault.app` copies. Never throws. */
export async function offerLegacyAppCleanup(deps: LegacyCleanupDeps): Promise<LegacyCleanupResult> {
  try {
    if (deps.platform !== 'darwin') return 'not-applicable'
    if (deps.getSetting(KEEP_LEGACY_SETTING) === '1') return 'already-declined'
    const copies = findLegacyCopies(deps)
    if (copies.length === 0) return 'none-found'

    const choice = await deps.ask(legacyCleanupDialog(copies))
    if (choice !== 0) {
      deps.setSetting(KEEP_LEGACY_SETTING, '1')
      deps.log('[legacy-app] user kept the older copy')
      return 'kept'
    }

    const failed = copies.filter(p => {
      const ok = deps.moveToTrash(p)
      deps.log(`[legacy-app] move ${p} to Trash: ${ok ? 'ok' : 'failed'}`)
      return !ok
    })
    if (failed.length === 0) return 'trashed'
    await deps.ask(trashFailedDialog(failed))
    return 'trash-failed'
  } catch (e: any) {
    deps.log(`[legacy-app] cleanup skipped: ${e?.message ?? e}`)
    return 'not-applicable'
  }
}
