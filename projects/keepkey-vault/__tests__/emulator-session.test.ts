/**
 * B1/B2: starting an emulator wallet runs what the start screen showed (the
 * wallet clicked, on the firmware shown beside it), never something else, and
 * a switch is not held up by a request still open on the old connection (a
 * PIN prompt included).
 *
 * Before: emulatorSwitchWallet took only a wallet name, so the firmware came
 * from a separate selection the picker never showed ("the signing build opened
 * the PIN wallet"), and a selected build that could not start stopped the
 * running emulator first.
 *
 * Temporary HOME only; the wallet files are placeholders, never real flashes.
 * Run: bun test __tests__/emulator-session.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectEmulatorBuild, selectEmulatorWallet, selectedEmulatorBuild, selectedEmulatorWallet, type SelectedEmulatorLibrary } from '../src/bun/emulator-library'
import { runningEmulatorIdentity, startEmulatorWallet, type EmulatorSessionDeps } from '../src/bun/emulator-session'

const SIGNING = 'a'.repeat(64)
const PIN_BUILD = 'b'.repeat(64)
const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

function rig(options: { running?: string | null; problemFor?: (id: string | null) => string | null; initError?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'kk-emu-session-'))
  homes.push(home)
  const dir = join(home, '.keepkey', 'emulator')
  mkdirSync(join(dir, 'builds'), { recursive: true })
  const wallets = ['pin-wallet', 'signing-wallet']
  for (const name of wallets) writeFileSync(join(dir, `${name}.enc`), 'placeholder, not a flash')
  const calls: string[] = []
  let running: string | null = options.running ?? null
  /** The old connection's PIN prompt: settles only when the engine lets go of it. */
  let releasePrompt: ((reason: Error) => void) | null = null
  const oldPrompt = new Promise<never>((_, reject) => { releasePrompt = reject })
  oldPrompt.catch(() => {})
  const deps: EmulatorSessionDeps = {
    home,
    getEmulatorStatus: () => ({ state: running ? 'running' : 'stopped', bridgeReady: !!running, host: '', paired: true, platform: 'darwin', flashImages: wallets, storagePath: dir }),
    stopEmulator: () => { calls.push(`stop ${running}`); running = null },
    initEmulator: (name: string) => {
      calls.push(`init ${name} on ${selectedEmulatorBuild(home) ?? 'bundled'}`)
      if (options.initError) return { state: 'error', error: options.initError } as any
      running = name
      return { state: 'running' } as any
    },
    openWindow: () => calls.push('open window'),
    closeWindow: () => calls.push('close window'),
    connectEmulator: async () => { calls.push('connect') },
    disconnectEmulator: () => { calls.push('disconnect'); releasePrompt?.(new Error('transport disconnected')) },
    listFlashImages: () => wallets,
    library: (): SelectedEmulatorLibrary => {
      const id = selectedEmulatorBuild(home)
      calls.push(`check ${id ?? 'bundled'}`)
      const problem = options.problemFor?.(id) ?? null
      return { id, path: problem ? null : '/lib', problem }
    },
    builds: () => [{ id: SIGNING }, { id: PIN_BUILD }],
  }
  return { home, deps, calls, oldPrompt, running: () => running }
}

describe('a start runs the firmware and wallet the start screen showed', () => {
  test('the wallet clicked starts on the build shown, and both become the saved selection', async () => {
    const r = rig({ running: 'pin-wallet' })
    selectEmulatorBuild(PIN_BUILD, r.home)
    selectEmulatorWallet('pin-wallet', r.home)
    await startEmulatorWallet(r.deps, { name: 'signing-wallet', buildId: SIGNING })
    expect(r.calls).toEqual([`check ${SIGNING}`, 'close window', 'disconnect', 'stop pin-wallet', `init signing-wallet on ${SIGNING}`, 'open window', 'connect'])
    expect(selectedEmulatorBuild(r.home)).toBe(SIGNING)
    expect(selectedEmulatorWallet(r.home)).toBe('signing-wallet')
  })

  test('the saved wallet selection never decides which wallet a start opens', async () => {
    const r = rig()
    selectEmulatorWallet('pin-wallet', r.home)
    await startEmulatorWallet(r.deps, { name: 'signing-wallet', buildId: SIGNING })
    expect(r.running()).toBe('signing-wallet')
  })

  test('no build given keeps the selected one; null is the bundled emulator', async () => {
    const r = rig()
    selectEmulatorBuild(PIN_BUILD, r.home)
    await startEmulatorWallet(r.deps, { name: 'pin-wallet' })
    expect(r.calls).toContain(`init pin-wallet on ${PIN_BUILD}`)
    await startEmulatorWallet(r.deps, { name: 'pin-wallet', buildId: null })
    expect(r.calls).toContain('init pin-wallet on bundled')
    expect(selectedEmulatorBuild(r.home)).toBeNull()
  })

  test('a build that cannot start is refused before the running emulator is touched; the selection is put back', async () => {
    const r = rig({ running: 'pin-wallet', problemFor: id => id === SIGNING ? 'The selected emulator firmware "v7.17.0 · Monero signing (research)" needs Monero.' : null })
    selectEmulatorBuild(PIN_BUILD, r.home)
    await expect(startEmulatorWallet(r.deps, { name: 'signing-wallet', buildId: SIGNING })).rejects.toThrow('needs Monero')
    expect(r.calls).toEqual([`check ${SIGNING}`])
    expect(r.running()).toBe('pin-wallet')
    expect(selectedEmulatorBuild(r.home)).toBe(PIN_BUILD)
  })

  test('a failed start on a new build leaves nothing running on it and puts the selections back', async () => {
    const r = rig({ initError: 'kkemu_init returned 3' })
    selectEmulatorBuild(PIN_BUILD, r.home)
    selectEmulatorWallet('pin-wallet', r.home)
    await expect(startEmulatorWallet(r.deps, { name: 'signing-wallet', buildId: SIGNING })).rejects.toThrow('kkemu_init returned 3')
    expect(selectedEmulatorBuild(r.home)).toBe(PIN_BUILD)
    expect(selectedEmulatorWallet(r.home)).toBe('pin-wallet')
    expect(r.calls.at(-1)).toBe('stop null')
  })

  test('a build that is not installed changes nothing', async () => {
    const r = rig({ running: 'pin-wallet' })
    await expect(startEmulatorWallet(r.deps, { name: 'signing-wallet', buildId: 'c'.repeat(64) })).rejects.toThrow('not installed')
    expect(r.calls).toEqual([])
    expect(readFileSync(join(r.home, '.keepkey', 'emulator', 'pin-wallet.enc'), 'utf8')).toBe('placeholder, not a flash')
  })
})

describe('B2: switching while the old wallet waits for its PIN', () => {
  test('the switch does not wait on the open PIN prompt: it lets go of it, and the prompt ends', async () => {
    const r = rig({ running: 'pin-wallet' })
    const started = Date.now()
    await startEmulatorWallet(r.deps, { name: 'signing-wallet' })
    expect(Date.now() - started).toBeLessThan(200)
    expect(await r.oldPrompt.then(() => 'resolved', (e: Error) => e.message)).toBe('transport disconnected')
    expect(r.calls.indexOf('disconnect')).toBeLessThan(r.calls.indexOf('init signing-wallet on bundled'))
  })

  test('even a request that never settles cannot hold the switch', async () => {
    const r = rig({ running: 'pin-wallet' })
    r.deps.disconnectEmulator = () => { r.calls.push('disconnect') } // the old request stays pending forever
    const started = Date.now()
    await startEmulatorWallet(r.deps, { name: 'signing-wallet' })
    expect(Date.now() - started).toBeLessThan(200)
    expect(r.running()).toBe('signing-wallet')
  })
})

describe('the running EMU badge names what was loaded', () => {
  test('wallet label and the build recorded at start, with the live firmware version', () => {
    expect(runningEmulatorIdentity({ flashName: 'build-92079869551ab26c', label: 'XMR test', firmwareVersion: '7.17.0',
      loaded: { id: SIGNING, version: '7.17.0', label: 'Monero signing (research)', research: true, path: '/x', problem: null } }))
      .toEqual({ wallet: { name: 'build-92079869551ab26c', label: 'XMR test' }, build: { id: SIGNING, version: '7.17.0', label: 'Monero signing (research)', research: true } })
    expect(runningEmulatorIdentity({ flashName: 'default', loaded: { id: null, path: '/b', problem: null }, firmwareVersion: '7.17.0' }))
      .toEqual({ wallet: { name: 'default' }, build: { id: null, version: '7.17.0' } })
  })
})

describe('the app uses this one implementation', () => {
  const index = readFileSync(join(import.meta.dir, '..', 'src/bun/index.ts'), 'utf8')
  test('emulatorSwitchWallet passes the build the picker showed', () => {
    const handler = index.slice(index.indexOf('emulatorSwitchWallet: async'), index.indexOf('emulatorGetMnemonic: async'))
    expect(handler).toContain('startEmulatorWallet(')
    expect(handler).toContain('buildId: params.buildId')
  })
  test('B5: the backend refuses to delete the running wallet unless the caller says it stops it', () => {
    const handler = index.slice(index.indexOf('emulatorDeleteFlash: async'), index.indexOf('emulatorListWallets: async'))
    const refusal = handler.indexOf("if (running && params.stopIfRunning !== true) throw new Error(")
    expect(refusal).toBeGreaterThan(0)
    expect(refusal).toBeLessThan(handler.indexOf('deleteFlash(params.name)'))
    const src = (file: string) => readFileSync(join(import.meta.dir, '..', file), 'utf8')
    expect(src('src/mainview/components/DeviceSettingsDrawer.tsx')).toContain('"emulatorDeleteFlash", { name, stopIfRunning: true }')
    expect(src('src/mainview/components/DeviceGrid.tsx')).toContain('"emulatorDeleteFlash", { name }')
  })
  test('B4: the EMU badge calls emulatorShowWindow, which focuses or reopens the running emulator', () => {
    const handler = index.slice(index.indexOf('emulatorShowWindow: async'), index.indexOf('emulatorSelectBuild: async'))
    expect(handler).toContain("if (getEmulatorStatus().state !== 'running') throw new Error('The emulator is not running')")
    expect(handler).toContain('showEmulatorWindow()')
    const nav = readFileSync(join(import.meta.dir, '..', 'src/mainview/components/TopNav.tsx'), 'utf8')
    expect(nav).toContain('<EmulatorBadge ')
  })
})
