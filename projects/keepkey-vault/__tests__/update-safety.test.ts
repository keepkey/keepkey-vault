/**
 * Firmware-update safety gates.
 *
 * An interrupted upload wipes the seed (bootloader storage-protection marker),
 * so: require a recovery-phrase confirmation before flashing any device that
 * may hold a wallet, and never tell the user their wallet survived when the
 * device came back empty.
 *
 * Run: bun test __tests__/update-safety.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { requiresBackupConfirmation, updateDoneWalletMessage } from '../src/mainview/lib/update-safety'
import { isDesktopVersionTag, selectDesktopUpdateRelease } from '../src/shared/desktop-update-release'

describe('desktop update release selection', () => {
  const release = (tag_name: string, prerelease = false, draft = false) => ({ tag_name, prerelease, draft })

  test('an internal native artifact cannot hide the desktop update in either channel', () => {
    const preview = release('v1.7.1', true), stable = release('v1.7.0')
    const releases = [release('monero-native-20261117', true), release('zcash-tools-20261116'), preview, stable]
    expect(selectDesktopUpdateRelease(releases, true)).toBe(preview)
    expect(selectDesktopUpdateRelease(releases, false)).toBe(stable)
  })

  test('drafts stay excluded and GitHub channel selection and release order are preserved', () => {
    const stable = release('v1.7.0'), olderPreview = release('v1.6.9', true)
    const releases = [release('v1.8.0', true, true), stable, olderPreview]
    expect(selectDesktopUpdateRelease(releases, true)).toBe(stable)
    expect(selectDesktopUpdateRelease(releases, false)).toBe(stable)
    expect(selectDesktopUpdateRelease([olderPreview], false)).toBeUndefined()
    expect(selectDesktopUpdateRelease([olderPreview], true)).toBe(olderPreview)
  })

  test('desktop tags require complete semver and allow valid prerelease/build identifiers', () => {
    for (const tag of ['v1.7.1', '1.7.1', 'v1.7.2-rc.1', 'v1.7.2-alpha.0+build.01', '0.0.0']) {
      expect(isDesktopVersionTag(tag)).toBe(true)
    }
    for (const tag of ['monero-native-20261117', 'v1.7', 'v1.7.1garbage', 'v01.7.1', 'v1.07.1',
      'v1.7.01', 'v1.7.2-01', 'v1.7.2-rc..1', 'v1.7.2+', ' v1.7.1', 'v1.7.1\n', 'v9007199254740992.0.0']) {
      expect(isDesktopVersionTag(tag)).toBe(false)
    }
  })

  test('no desktop release and malformed API records cannot become an update candidate', () => {
    expect(selectDesktopUpdateRelease([release('monero-native-20261117', true)], true)).toBeUndefined()
    expect(selectDesktopUpdateRelease([null, {}, { tag_name: 'v1.7.1', draft: false },
      { tag_name: 'v1.7.1', draft: 'false', prerelease: false }], true)).toBeUndefined()
    expect(selectDesktopUpdateRelease({ message: 'API unavailable' }, true)).toBeUndefined()
  })
})

describe('requiresBackupConfirmation', () => {
  test('app mode: initialized device requires it, uninitialized does not', () => {
    expect(requiresBackupConfirmation({ bootloaderMode: false, initialized: true, isOob: false }, null)).toBe(true)
    expect(requiresBackupConfirmation({ bootloaderMode: false, initialized: false, isOob: true }, null)).toBe(false)
  })

  test('bootloader mode with no prior app-mode read fails closed', () => {
    expect(requiresBackupConfirmation({ bootloaderMode: true, initialized: true, isOob: false }, null)).toBe(true)
  })

  test('bootloader mode trusts an earlier app-mode read', () => {
    expect(requiresBackupConfirmation({ bootloaderMode: true, initialized: true, isOob: false }, false)).toBe(false)
    expect(requiresBackupConfirmation({ bootloaderMode: true, initialized: true, isOob: false }, true)).toBe(true)
  })

  test('bootloader mode with no firmware on flash (OOB) skips', () => {
    expect(requiresBackupConfirmation({ bootloaderMode: true, initialized: true, isOob: true }, null)).toBe(false)
  })
})

describe('updateDoneWalletMessage', () => {
  test('wallet present after update -> kept', () => {
    expect(updateDoneWalletMessage({ state: 'ready', bootloaderMode: false, initialized: true })).toBe('kept')
    expect(updateDoneWalletMessage({ state: 'needs_pin', bootloaderMode: false, initialized: true })).toBe('kept')
  })

  test('device came back empty -> never the reassurance', () => {
    expect(updateDoneWalletMessage({ state: 'needs_init', bootloaderMode: false, initialized: false })).toBe('empty')
  })

  test('unknown / bootloader -> claim nothing', () => {
    expect(updateDoneWalletMessage({ state: 'bootloader', bootloaderMode: true, initialized: true })).toBe(null)
    expect(updateDoneWalletMessage({ state: 'connected_unpaired', bootloaderMode: false, initialized: true })).toBe(null)
  })
})
