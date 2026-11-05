import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bundledEmulatorCandidates, clearSelectedEmulatorWallet, emulatorBuildFlashName, emulatorBuildPath, emulatorLibFilename, listEmulatorBuilds, resolveEmulatorLibPath, resolveEmulatorWalletName, selectEmulatorBuild, selectEmulatorWallet, selectedEmulatorWallet } from './emulator-library'

describe('emulator release library resolution', () => {
  test('uses the correct platform filenames', () => {
    expect(emulatorLibFilename('darwin')).toBe('libkkemu.dylib')
    expect(emulatorLibFilename('win32')).toBe('libkkemu.dll')
  })

  test('finds a library copied to Resources/app/emulator', () => {
    const candidates = bundledEmulatorCandidates('/app/Contents/Resources/app/bun', '/unused', 'darwin')
    const bundled = '/app/Contents/Resources/app/emulator/libkkemu.dylib'
    expect(candidates).toContain(bundled)
    expect(resolveEmulatorLibPath({
      importDir: '/app/Contents/Resources/app/bun',
      cwd: '/unused',
      home: '/home/test',
      platform: 'darwin',
      exists: path => path === bundled,
    })).toBe(bundled)
  })

  test('keeps a user-installed library as an explicit override', () => {
    const override = '/home/test/.keepkey/emulator/libkkemu.dll'
    expect(resolveEmulatorLibPath({
      importDir: 'C:/app/Resources/app/bun',
      cwd: 'C:/app',
      home: '/home/test',
      platform: 'win32',
      exists: path => path === override || path.endsWith('/emulator/libkkemu.dll'),
    })).toBe(override)
  })

  test('selects installed builds by content ID and refuses a missing selected build', () => {
    const home = mkdtempSync(join(tmpdir(), 'kk-emu-builds-'))
    const first = 'a'.repeat(64)
    const second = 'b'.repeat(64)
    try {
      const firstPath = emulatorBuildPath(first, 'darwin', home)
      const secondPath = emulatorBuildPath(second, 'darwin', home)
      mkdirSync(join(home, '.keepkey', 'emulator', 'builds'), { recursive: true })
      writeFileSync(firstPath, 'first')
      writeFileSync(secondPath, 'second')
      selectEmulatorBuild(second, home)
      expect(emulatorBuildFlashName(second)).toBe(`build-${'b'.repeat(16)}`)
      expect(listEmulatorBuilds('darwin', home).map(b => [b.id, b.selected])).toEqual([[first, false], [second, true]])
      expect(resolveEmulatorLibPath({ importDir: '/unused', home, platform: 'darwin' })).toBe(secondPath)
      rmSync(secondPath)
      expect(resolveEmulatorLibPath({ importDir: '/unused', home, platform: 'darwin' })).toBeNull()
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})

describe('saved emulator wallet continuity', () => {
  const firstBuild = 'a'.repeat(64)
  const secondBuild = 'b'.repeat(64)
  const firstWallet = emulatorBuildFlashName(firstBuild)

  function fixture(run: (home: string, dir: string) => void) {
    const home = mkdtempSync(join(tmpdir(), 'kk-emu-wallet-selection-'))
    const dir = join(home, '.keepkey', 'emulator')
    mkdirSync(dir, { recursive: true })
    // Deliberately not a decryptable flash. Selection must only inspect names
    // and existence, without reading any seed or encrypted wallet contents.
    writeFileSync(join(dir, `${firstWallet}.enc`), 'encrypted fixture stays untouched')
    writeFileSync(join(dir, 'another-wallet.enc'), 'distinct encrypted wallet')
    try { run(home, dir) }
    finally { rmSync(home, { recursive: true, force: true }) }
  }

  test('persists only the saved name and resumes it after restart and firmware selection changes', () => fixture((home, dir) => {
    selectEmulatorWallet(firstWallet, home)
    selectEmulatorBuild(secondBuild, home)
    expect(selectedEmulatorWallet(home)).toBe(firstWallet)
    expect(resolveEmulatorWalletName({ buildId: secondBuild, home })).toBe(firstWallet)
    expect(readFileSync(join(dir, 'selected-wallet'), 'utf8')).toBe(`${firstWallet}\n`)
    expect(readFileSync(join(dir, `${firstWallet}.enc`), 'utf8')).toBe('encrypted fixture stays untouched')
    expect(readFileSync(join(dir, 'another-wallet.enc'), 'utf8')).toBe('distinct encrypted wallet')
    expect(readdirSync(dir).some(name => name.endsWith('.mnemonic.enc'))).toBe(false)
  }))

  test('preserves the running saved wallet across a build change before consulting the previous selection', () => fixture((home) => {
    selectEmulatorWallet('another-wallet', home)
    expect(resolveEmulatorWalletName({ running: firstWallet, buildId: secondBuild, home })).toBe(firstWallet)
    expect(selectedEmulatorWallet(home)).toBe('another-wallet') // resolving is read-only
  }))

  test('an explicit saved wallet overrides the persisted and running choices', () => fixture((home) => {
    selectEmulatorWallet(firstWallet, home)
    expect(resolveEmulatorWalletName({ explicit: 'another-wallet', running: firstWallet, buildId: secondBuild, home })).toBe('another-wallet')
  }))

  test('keeps the legacy build/default fallback only when no wallet has been selected', () => fixture((home, dir) => {
    expect(resolveEmulatorWalletName({ buildId: secondBuild, home })).toBe(emulatorBuildFlashName(secondBuild))
    expect(resolveEmulatorWalletName({ home })).toBe('default')
    expect(existsSync(join(dir, `${emulatorBuildFlashName(secondBuild)}.enc`))).toBe(false)
    expect(selectedEmulatorWallet(home)).toBeNull()
  }))

  test('a missing selected wallet fails without creating a blank image and can be explicitly recovered', () => fixture((home, dir) => {
    selectEmulatorWallet(firstWallet, home)
    rmSync(join(dir, `${firstWallet}.enc`))
    expect(() => resolveEmulatorWalletName({ buildId: secondBuild, home })).toThrow('is missing')
    expect(() => resolveEmulatorWalletName({ explicit: firstWallet, home })).toThrow('is missing')
    expect(existsSync(join(dir, `${emulatorBuildFlashName(secondBuild)}.enc`))).toBe(false)
    expect(resolveEmulatorWalletName({ explicit: 'another-wallet', home })).toBe('another-wallet')
    selectEmulatorWallet('another-wallet', home)
    expect(resolveEmulatorWalletName({ buildId: secondBuild, home })).toBe('another-wallet')
  }))

  test('invalid or corrupt persisted selections fail closed while an explicit existing name permits recovery', () => fixture((home, dir) => {
    for (const invalid of ['../escape', '', 'wallet.mnemonic', 'folder/wallet']) {
      writeFileSync(join(dir, 'selected-wallet'), invalid)
      expect(() => resolveEmulatorWalletName({ buildId: secondBuild, home })).toThrow('selection is invalid')
      expect(resolveEmulatorWalletName({ explicit: firstWallet, home })).toBe(firstWallet)
    }
    expect(() => selectEmulatorWallet('../escape', home)).toThrow('path separators')
    expect(() => selectEmulatorWallet('absent', home)).toThrow('is missing')
    expect(existsSync(join(dir, 'absent.enc'))).toBe(false)
  }))

  test('clearing an intentionally deleted wallet selection restores first-use fallback without touching other wallets', () => fixture((home, dir) => {
    selectEmulatorWallet(firstWallet, home)
    clearSelectedEmulatorWallet(home)
    expect(selectedEmulatorWallet(home)).toBeNull()
    expect(resolveEmulatorWalletName({ buildId: secondBuild, home })).toBe(emulatorBuildFlashName(secondBuild))
    expect(existsSync(join(dir, 'another-wallet.enc'))).toBe(true)
  }))
})
