/**
 * B3: a selected emulator firmware that can't start says which one and what
 * to do. It never starts a different firmware in its place.
 *
 * Before: every cause gave "Bundled emulator missing. Drop a libkkemu.dylib onto
 * the window or run: make build-emulator" (log 2026-11-06 18:51:55), and turning
 * Monero off silently dropped a research selection, so the next start ran the
 * bundled firmware instead.
 *
 * Run: bun test __tests__/emulator-build-unavailable.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emulatorBuildPath, recordEmulatorBuildVersion, resolveEmulatorLibPath, selectEmulatorBuild, selectedEmulatorLibrary } from '../src/bun/emulator-library'

const GENERIC = 'Bundled emulator missing'
const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })

/** A temporary HOME, a bundled default library, and a staged Monero signing manifest. */
function fixture({ signingDylib = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kk-emu-unavailable-'))
  temporary.push(root)
  const home = join(root, 'home')
  mkdirSync(join(home, '.keepkey', 'emulator', 'builds'), { recursive: true })
  const app = join(root, 'app')
  mkdirSync(join(app, 'emulator-bundle'), { recursive: true })
  const bundled = join(app, 'emulator-bundle', 'libkkemu.dylib')
  writeFileSync(bundled, 'the bundled default firmware')
  const monero = join(app, 'monero-emulator-bundle')
  mkdirSync(monero)
  const bytes = new Uint8Array(64)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0xfeedfacf, true); view.setUint32(4, 0x0100000c, true); view.setUint32(12, 6, true); bytes[40] = 1
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(join(monero, 'signing-manifest.json'), JSON.stringify({
    schemaVersion: 1, label: 'Monero signing (research)', version: '7.17.0', research: true,
    capabilities: ['address', 'watch-key', 'key-image', 'sign'], signingEnabled: true,
    files: { 'darwin-arm64': { filename: 'libkkemu-monero-signing.dylib', sha256, size: bytes.length } },
  }))
  if (signingDylib) writeFileSync(join(monero, 'libkkemu-monero-signing.dylib'), bytes)
  const options = { importDir: join(app, 'bun'), cwd: app, home, platform: 'darwin' as const, arch: 'arm64' }
  return { root, home, app, bundled, sha256, options }
}

describe('a selected emulator firmware that is not available', () => {
  test('a Monero research build with Monero off names the build and says to turn Monero on; no fallback', () => {
    const f = fixture({ signingDylib: true })
    selectEmulatorBuild(f.sha256, f.home)
    const state = selectedEmulatorLibrary({ ...f.options, moneroEnabled: false })
    expect(state.path).toBeNull()
    expect(state.problem).toContain('v7.17.0 · Monero signing (research)')
    expect(state.problem).toContain('Turn Monero on')
    expect(state.problem).not.toContain(GENERIC)
    // The bundled default is right there, and is still not used in its place.
    expect(resolveEmulatorLibPath({ ...f.options, moneroEnabled: false })).toBeNull()
    expect(selectedEmulatorLibrary({ ...f.options, moneroEnabled: true }).path).toBe(join(f.app, 'monero-emulator-bundle', 'libkkemu-monero-signing.dylib'))
  })

  test('a research build whose library is missing from this app names it and says how to get it', () => {
    const f = fixture()
    selectEmulatorBuild(f.sha256, f.home)
    const state = selectedEmulatorLibrary({ ...f.options, moneroEnabled: true })
    expect(state.path).toBeNull()
    expect(state.problem).toContain('v7.17.0 · Monero signing (research)')
    expect(state.problem).toContain('missing from this app or failed its integrity check')
    expect(state.problem).not.toContain(GENERIC)
  })

  test('an installed build whose file was deleted names it (version and build id) and the file', () => {
    const f = fixture()
    const id = 'c'.repeat(64)
    writeFileSync(emulatorBuildPath(id, 'darwin', f.home), 'installed')
    recordEmulatorBuildVersion(id, '7.16.0', f.home)
    selectEmulatorBuild(id, f.home)
    expect(selectedEmulatorLibrary(f.options)).toMatchObject({ id, version: '7.16.0', problem: null })
    rmSync(emulatorBuildPath(id, 'darwin', f.home))
    const state = selectedEmulatorLibrary(f.options)
    expect(state.path).toBeNull()
    expect(state.problem).toContain('v7.16.0 · build cccccccccccc')
    expect(state.problem).toContain(emulatorBuildPath(id, 'darwin', f.home))
    expect(state.problem).toContain('Pick another firmware')
    expect(state.problem).not.toContain(GENERIC)
  })

  test('nothing selected and nothing installed is the one case for the bundled-library message', () => {
    const f = fixture()
    rmSync(f.bundled)
    const state = selectedEmulatorLibrary(f.options)
    expect(state).toMatchObject({ id: null, path: null })
    expect(state.problem).toContain(GENERIC)
    writeFileSync(f.bundled, 'back')
    expect(selectedEmulatorLibrary(f.options)).toMatchObject({ id: null, path: f.bundled, problem: null })
  })

  test('starting the emulator shows that message, before any flash is read or created', () => {
    const f = fixture()
    selectEmulatorBuild('d'.repeat(64), f.home)
    const run = Bun.spawnSync([process.execPath, '-e', `
      const { initEmulator } = await import(${JSON.stringify(join(import.meta.dir, '..', 'src/bun/emulator.ts'))})
      console.log(JSON.stringify(initEmulator('fixture-wallet')))`], { env: { ...process.env, HOME: f.home }, stdout: 'pipe', stderr: 'pipe' })
    const status = JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)
    expect(status.state).toBe('error')
    expect(status.error).toContain('build dddddddddddd')
    expect(status.error).not.toContain(GENERIC)
    expect(require('node:fs').readdirSync(join(f.home, '.keepkey', 'emulator')).filter((n: string) => n.endsWith('.enc'))).toEqual([])
  }, 30_000) // a child process loading the emulator module
})

describe('turning Monero off', () => {
  const index = readFileSync(join(import.meta.dir, '..', 'src/bun/index.ts'), 'utf8')
  test('keeps the research selection: the next start names it instead of running other firmware', () => {
    const handler = index.slice(index.indexOf('setMoneroEnabled: async'), index.indexOf('setMoneroNode: async'))
    expect(handler.length).toBeGreaterThan(0)
    expect(handler).not.toContain('clearSelectedEmulatorBuild')
  })
})
