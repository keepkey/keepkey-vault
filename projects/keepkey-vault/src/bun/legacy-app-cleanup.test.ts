import { describe, expect, test } from 'bun:test'
import {
  BUNDLE_IDENTIFIER,
  KEEP_LEGACY_SETTING,
  findLegacyCopies,
  offerLegacyAppCleanup,
  runningBundlePath,
  type LegacyCleanupDeps,
  type LegacyCleanupDialog,
} from './legacy-app-cleanup'

const HOME = '/Users/alice'
const NEW_APP = '/Applications/KeepKey Vault.app'
const OLD_APP = '/Applications/keepkey-vault.app'
const OLD_USER_APP = `${HOME}/Applications/keepkey-vault.app`

function harness(over: Partial<LegacyCleanupDeps> & {
  files?: Record<string, string | null> // path -> bundle id (null = not ours)
  links?: Record<string, string>
  answers?: number[]
  trashOk?: boolean
  versions?: Record<string, string>
} = {}) {
  const versions = over.versions ?? { [NEW_APP]: '1.6.11', [OLD_APP]: '1.6.10', [OLD_USER_APP]: '1.6.9' }
  const files = over.files ?? { [NEW_APP]: BUNDLE_IDENTIFIER, [OLD_APP]: BUNDLE_IDENTIFIER }
  const links = over.links ?? {}
  const settings = new Map<string, string>()
  const dialogs: LegacyCleanupDialog[] = []
  const trashed: string[] = []
  const answers = [...(over.answers ?? [0])]
  const deps: LegacyCleanupDeps = {
    platform: 'darwin',
    execPath: `${NEW_APP}/Contents/MacOS/launcher`,
    homeDir: HOME,
    exists: p => p in files,
    realpath: p => {
      if (!(p in files)) throw new Error('ENOENT')
      return links[p] ?? p
    },
    bundleIdentifier: p => files[p] ?? null,
    bundleVersion: p => versions[p] ?? null,
    getSetting: k => settings.get(k) ?? null,
    setSetting: (k, v) => { settings.set(k, v) },
    ask: async d => { dialogs.push(d); return answers.shift() ?? 0 },
    moveToTrash: p => { trashed.push(p); return over.trashOk ?? true },
    log: () => {},
    ...over,
  }
  return { deps, settings, dialogs, trashed }
}

describe('runningBundlePath', () => {
  test('finds the .app two levels above the binary', () => {
    expect(runningBundlePath(`${NEW_APP}/Contents/MacOS/bun`)).toBe(NEW_APP)
  })
  test('null outside a bundle', () => {
    expect(runningBundlePath('/usr/local/bin/bun')).toBeNull()
  })
})

describe('findLegacyCopies', () => {
  test('finds the old copy next to the new one', () => {
    expect(findLegacyCopies(harness().deps)).toEqual([OLD_APP])
  })

  test('also finds an old copy in ~/Applications', () => {
    const { deps } = harness({ files: { [NEW_APP]: BUNDLE_IDENTIFIER, [OLD_APP]: BUNDLE_IDENTIFIER, [OLD_USER_APP]: BUNDLE_IDENTIFIER } })
    expect(findLegacyCopies(deps)).toEqual([OLD_APP, OLD_USER_APP])
  })

  test('ignores an old-named bundle that is some other app', () => {
    const { deps } = harness({ files: { [NEW_APP]: BUNDLE_IDENTIFIER, [OLD_APP]: 'com.example.other' } })
    expect(findLegacyCopies(deps)).toEqual([])
  })

  test('does nothing when the running app still has the old name', () => {
    const { deps } = harness({ execPath: `${OLD_APP}/Contents/MacOS/launcher` })
    expect(findLegacyCopies(deps)).toEqual([])
  })

  test('does nothing when run straight from the DMG', () => {
    const { deps } = harness({ execPath: '/Volumes/KeepKey Vault/KeepKey Vault.app/Contents/MacOS/launcher' })
    expect(findLegacyCopies(deps)).toEqual([])
  })

  test('does nothing for dev builds', () => {
    const { deps } = harness({ execPath: '/repo/_build/dev-macos-arm64/keepkey-vault-dev.app/Contents/MacOS/launcher' })
    expect(findLegacyCopies(deps)).toEqual([])
  })

  test('never offers the running app itself (old name is a link to it)', () => {
    const { deps } = harness({ links: { [OLD_APP]: NEW_APP } })
    expect(findLegacyCopies(deps)).toEqual([])
  })

  test('lists a copy once when both paths resolve to it', () => {
    const { deps } = harness({
      files: { [NEW_APP]: BUNDLE_IDENTIFIER, [OLD_APP]: BUNDLE_IDENTIFIER, [OLD_USER_APP]: BUNDLE_IDENTIFIER },
      links: { [OLD_USER_APP]: OLD_APP },
    })
    expect(findLegacyCopies(deps)).toEqual([OLD_APP])
  })

  test('offers an old copy at an older or equal version', () => {
    const { deps } = harness({ versions: { [NEW_APP]: '1.6.11', [OLD_APP]: '1.6.10' } })
    expect(findLegacyCopies(deps)).toEqual([OLD_APP])
    const same = harness({ versions: { [NEW_APP]: '1.6.11', [OLD_APP]: '1.6.11' } })
    expect(findLegacyCopies(same.deps)).toEqual([OLD_APP])
  })

  test('leaves an old-named copy that auto-updated past this one', () => {
    const { deps } = harness({ versions: { [NEW_APP]: '1.6.11', [OLD_APP]: '1.7.0' } })
    expect(findLegacyCopies(deps)).toEqual([])
  })

  test('leaves the old copy alone when its version is unreadable', () => {
    const { deps } = harness({ versions: { [NEW_APP]: '1.6.11' } })
    expect(findLegacyCopies(deps)).toEqual([])
  })

  test('leaves the old copy alone when the running version is unreadable', () => {
    const { deps } = harness({ versions: { [OLD_APP]: '1.6.10' } })
    expect(findLegacyCopies(deps)).toEqual([])
  })

  test('does nothing off macOS', () => {
    expect(findLegacyCopies(harness({ platform: 'win32' }).deps)).toEqual([])
  })
})

describe('offerLegacyAppCleanup', () => {
  test('trashes the old copy when the user agrees', async () => {
    const h = harness({ answers: [0] })
    expect(await offerLegacyAppCleanup(h.deps)).toBe('trashed')
    expect(h.trashed).toEqual([OLD_APP])
    expect(h.dialogs).toHaveLength(1)
    expect(h.dialogs[0].detail).toContain(OLD_APP)
  })

  test('keeps it, remembers, and never asks again', async () => {
    const h = harness({ answers: [1] })
    expect(await offerLegacyAppCleanup(h.deps)).toBe('kept')
    expect(h.trashed).toEqual([])
    expect(h.settings.get(KEEP_LEGACY_SETTING)).toBe('1')
    expect(await offerLegacyAppCleanup(h.deps)).toBe('already-declined')
    expect(h.dialogs).toHaveLength(1)
  })

  test('closing the dialog counts as keep', async () => {
    const h = harness({ answers: [-1] })
    expect(await offerLegacyAppCleanup(h.deps)).toBe('kept')
    expect(h.trashed).toEqual([])
  })

  test('tells the user when the Trash move fails', async () => {
    const h = harness({ answers: [0, 0], trashOk: false })
    expect(await offerLegacyAppCleanup(h.deps)).toBe('trash-failed')
    expect(h.dialogs).toHaveLength(2)
    expect(h.dialogs[1].type).toBe('error')
    expect(h.dialogs[1].detail).toContain(OLD_APP)
    expect(h.settings.get(KEEP_LEGACY_SETTING)).toBeUndefined()
  })

  test('asks nothing when there is no old copy', async () => {
    const h = harness({ files: { [NEW_APP]: BUNDLE_IDENTIFIER } })
    expect(await offerLegacyAppCleanup(h.deps)).toBe('none-found')
    expect(h.dialogs).toHaveLength(0)
  })

  test('never throws', async () => {
    const h = harness({ getSetting: () => { throw new Error('db closed') } })
    expect(await offerLegacyAppCleanup(h.deps)).toBe('not-applicable')
    expect(h.trashed).toEqual([])
  })
})
