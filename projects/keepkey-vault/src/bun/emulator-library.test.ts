import { describe, expect, test } from 'bun:test'
import { bundledEmulatorCandidates, emulatorLibFilename, resolveEmulatorLibPath } from './emulator-library'

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
})
