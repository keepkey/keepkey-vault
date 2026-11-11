import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('a delayed old emulator close cannot stop its replacement display', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kk-emu-window-lifecycle-'))
  try {
    const result = Bun.spawnSync([process.execPath, new URL('./fixtures/emulator-window-lifecycle.ts', import.meta.url).pathname], {
      env: { ...process.env, KK_EMULATOR_WINDOW_TEST_DIR: dir },
      stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
    })
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toContain('cancelled start passed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the EMU badge brings the emulator window forward, or reopens it with its screen and PIN prompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kk-emu-window-show-'))
  try {
    const result = Bun.spawnSync([process.execPath, new URL('./fixtures/emulator-window-show.ts', import.meta.url).pathname], {
      env: { ...process.env, KK_EMULATOR_WINDOW_TEST_DIR: dir },
      stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
    })
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toContain('fresh start passed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
