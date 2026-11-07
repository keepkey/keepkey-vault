/**
 * What the user sees and clicks when picking, running and deleting emulator
 * wallets (B1, B3, B4, B5). Rendered in jsdom and clicked, in a child process.
 *
 * Before: the seed picker had no firmware choice, so a start ran whatever build
 * a separate selection held; wallets showed only file names like
 * "build-249bcff134356ee7"; the EMU badge was plain text naming neither the
 * wallet nor the firmware; delete asked only 'Delete "name"', without saying
 * it can't be undone.
 *
 * Run: bun test __tests__/emulator-selection-ui.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test'

const SIGNING = '92079869551ab26ccd41d33ede1fe6c69735927e38a3203f932cdb37abe134f7'
let ui: Record<string, any>

beforeAll(() => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/emulator-selection-ui.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
  })
  if (run.exitCode !== 0) throw new Error(run.stderr.toString())
  ui = JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)
}, 120_000) // a child process rendering React: ~1 s alone, far slower on a loaded machine

describe('B1: the start screen shows and sets firmware and wallet together', () => {
  test('the firmware select names every build by version and what it is, with the selected one shown', () => {
    expect(ui.firmwareOptions).toEqual(['Bundled emulator', 'v7.17.0 · build 249bcff13435', 'v7.17.0 · Monero signing (research)'])
    expect(ui.firmwareShown).toBe('v7.17.0 · build 249bcff13435')
  })
  test('wallets carry human labels and keep file hashes out of the normal list', () => {
    expect(ui.walletTitles[0].startsWith('PIN wallet (running)')).toBe(true)
    expect(ui.walletTitles[1].startsWith('XMR mainnet (last used)')).toBe(true)
    expect(ui.walletTitles[2].startsWith('Unnamed wallet')).toBe(true)
    expect(ui.walletTitles[3].startsWith('my-test-seed')).toBe(true)
    expect(ui.walletTitles.join(' ')).not.toContain('build-')
  })
  test('the wallet clicked starts on the firmware shown: each pick carries the build', () => {
    expect(ui.picks).toEqual([['build-92079869551ab26c', SIGNING], ['my-test-seed', null]])
  })
})

test('an obsolete signing hash uses the reviewed signing version with the wallet the user chose', () => {
  expect(ui.recommendedVersion).toBe(SIGNING)
  expect(ui.recommendedPicks).toEqual([['build-92079869551ab26c', SIGNING]])
  expect(ui.recoverySummary).not.toContain('/private/path')
})

describe('B3: an unavailable selected build', () => {
  test('uses the current available version and explains the replacement', () => {
    expect(ui.unavailableShown).toBe('Bundled emulator')
    expect(ui.unavailableProblem).toContain('previous emulator version is unavailable')
    expect(ui.unavailableProblem).not.toContain('Bundled emulator missing')
  })
  test('keeps the chosen wallet while replacing an unavailable version', () => {
    expect(ui.unavailablePicks).toEqual(['build-92079869551ab26c'])
    expect(ui.problemAfterSwitch).toBe('gone')
    expect(ui.picksAfterSwitch).toEqual(['build-92079869551ab26c', 'build-92079869551ab26c'])
  })
})

describe("Settings' build select", () => {
  test('a selected research build hidden while Monero is off shows as unavailable, not as the bundled emulator', () => {
    expect(ui.settingsOptions).toEqual(['Bundled emulator', 'v7.17.0 · build 249bcff13435', 'v7.17.0 · Monero signing (research) · 92079869551a (unavailable)'])
    expect(ui.settingsShown).toBe('v7.17.0 · Monero signing (research) · 92079869551a (unavailable)')
  })
  test('picking the bundled emulator from there is a change (before, it was already "shown" and fired nothing)', () => {
    expect(ui.settingsChanges).toEqual([''])
    expect(ui.settingsShownAfter).toBe('Bundled emulator')
  })
})

describe('B5: deleting a seed', () => {
  test('wallet management is on demand and the running wallet has no delete', () => {
    expect(ui.deleteButtonsBeforeManage).toBe(0)
    expect(ui.deleteButtons).toEqual(['Delete seed XMR mainnet', 'Delete seed Unnamed wallet', 'Delete seed my-test-seed'])
  })
  test('× only asks; the question names the wallet and its file and says it cannot be undone', () => {
    expect(ui.deletedAfterX).toEqual([])
    expect(ui.confirmText).toBe('Delete "XMR mainnet" (build-92079869551ab26c)? Its flash and saved seed are erased from this computer. This can\'t be undone.')
  })
  test('Keep deletes nothing; Delete deletes exactly that wallet', () => {
    expect(ui.confirmAfterKeep).toBe('closed')
    expect(ui.deletedAfterKeep).toEqual([])
    expect(ui.deleted).toEqual(['build-92079869551ab26c'])
  })
})

describe('B1/B4: the running EMU badge', () => {
  test('names the wallet and the firmware, and clicking it asks to show the emulator window', () => {
    expect(ui.badgeText).toBe('EMUXMR mainnetv7.17.0 · Monero signing (research)')
    expect(ui.badgeTitle).toBe('Emulator: XMR mainnet on v7.17.0 · Monero signing (research). Click to show the emulator window.')
    expect(ui.badgeShows).toBe(1)
    expect(ui.badgeUnnamed).toBe('EMUUnnamed walletv7.17.0 · bundled emulator')
  })
})
