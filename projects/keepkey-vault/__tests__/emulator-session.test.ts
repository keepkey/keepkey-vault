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
import { activateEmulatorBuild, deleteEmulatorWallet, runningEmulatorIdentity, startEmulatorWallet, type EmulatorSessionDeps } from '../src/bun/emulator-session'

const SIGNING = 'a'.repeat(64)
const PIN_BUILD = 'b'.repeat(64)
const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

function rig(options: { running?: string | null; problemFor?: (id: string | null) => string | null; initError?: string; initErrorFor?: string } = {}) {
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
    getActiveFlashName: () => running ?? 'default',
    firmwareVersion: () => '7.17.0',
    stopEmulator: () => { calls.push(`stop ${running}`); running = null },
    initEmulator: (name: string) => {
      calls.push(`init ${name} on ${selectedEmulatorBuild(home) ?? 'bundled'}`)
      if (options.initError && (!options.initErrorFor || options.initErrorFor === name)) return { state: 'error', error: options.initError } as any
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

  test('a failed start on a new build puts the selections back and starts the previous wallet again on its build', async () => {
    const r = rig({ running: 'pin-wallet', initError: 'kkemu_init returned 3', initErrorFor: 'signing-wallet' })
    selectEmulatorBuild(PIN_BUILD, r.home)
    selectEmulatorWallet('pin-wallet', r.home)
    await expect(startEmulatorWallet(r.deps, { name: 'signing-wallet', buildId: SIGNING })).rejects.toThrow('kkemu_init returned 3')
    expect(selectedEmulatorBuild(r.home)).toBe(PIN_BUILD)
    expect(selectedEmulatorWallet(r.home)).toBe('pin-wallet')
    expect(r.running()).toBe('pin-wallet')
    expect(r.calls.slice(-3)).toEqual([`init pin-wallet on ${PIN_BUILD}`, 'open window', 'connect'])
  })

  test('nothing was running: a failed start leaves nothing running and the selections as they were', async () => {
    const r = rig({ initError: 'kkemu_init returned 3' })
    selectEmulatorBuild(PIN_BUILD, r.home)
    await expect(startEmulatorWallet(r.deps, { name: 'signing-wallet', buildId: SIGNING })).rejects.toThrow('kkemu_init returned 3')
    expect(selectedEmulatorBuild(r.home)).toBe(PIN_BUILD)
    expect(r.running()).toBeNull()
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

describe("Settings' build select (emulatorActivateBuild) takes the same path", () => {
  test('the running wallet moves to the chosen build, and its version is recorded', async () => {
    const r = rig({ running: 'pin-wallet' })
    selectEmulatorBuild(PIN_BUILD, r.home)
    expect((await activateEmulatorBuild(r.deps, SIGNING)).flashName).toBe('pin-wallet')
    expect(r.calls).toContain(`init pin-wallet on ${SIGNING}`)
    expect(readFileSync(join(r.home, '.keepkey', 'emulator', 'builds', `${SIGNING}.version`), 'utf8').trim()).toBe('7.17.0')
  })
  test('a build that cannot start is refused before the running wallet is stopped', async () => {
    const r = rig({ running: 'pin-wallet', problemFor: id => id === SIGNING ? 'needs Monero' : null })
    selectEmulatorBuild(PIN_BUILD, r.home)
    await expect(activateEmulatorBuild(r.deps, SIGNING)).rejects.toThrow('needs Monero')
    expect(r.calls).toEqual([`check ${SIGNING}`])
    expect(r.running()).toBe('pin-wallet')
    expect(selectedEmulatorBuild(r.home)).toBe(PIN_BUILD)
  })
  test('a failed start restores the build and restarts the wallet that was running', async () => {
    const r = rig({ running: 'pin-wallet' })
    selectEmulatorBuild(PIN_BUILD, r.home)
    const starts: string[] = []
    r.deps.initEmulator = (name) => {
      const build = selectedEmulatorBuild(r.home) ?? 'bundled'
      starts.push(`${name} on ${build}`)
      return build === SIGNING ? { state: 'error', error: 'kkemu_init returned 3' } as any : { state: 'running' } as any
    }
    await expect(activateEmulatorBuild(r.deps, SIGNING)).rejects.toThrow('kkemu_init returned 3')
    expect(starts).toEqual([`pin-wallet on ${SIGNING}`, `pin-wallet on ${PIN_BUILD}`])
    expect(selectedEmulatorBuild(r.home)).toBe(PIN_BUILD)
  })
  test('the bundled emulator (null) clears the build selection', async () => {
    const r = rig({ running: 'pin-wallet' })
    selectEmulatorBuild(PIN_BUILD, r.home)
    await activateEmulatorBuild(r.deps, null)
    expect(selectedEmulatorBuild(r.home)).toBeNull()
    expect(r.calls).toContain('init pin-wallet on bundled')
  })
})

describe('B5: deleting a saved wallet', () => {
  function deletion(running: string | null) {
    const calls: string[] = []
    let current = running
    return {
      calls, start: (name: string) => { current = name },
      deps: {
        isRunning: (name: string) => current === name,
        prepare: async (name: string) => { calls.push(`prepare ${name}`) },
        stopRunning: () => { calls.push(`stop ${current}`); current = null },
        erase: (name: string) => { calls.push(`erase ${name}`) },
      },
    }
  }
  test('the running wallet is refused before anything happens', async () => {
    const d = deletion('pin-wallet')
    await expect(deleteEmulatorWallet(d.deps, { name: 'pin-wallet' })).rejects.toThrow('"pin-wallet" is running. Stop the emulator before deleting it.')
    expect(d.calls).toEqual([])
  })
  test('a wallet started while the delete awaited is refused, not erased under the running emulator', async () => {
    const d = deletion(null)
    d.deps.prepare = async (name: string) => { d.calls.push(`prepare ${name}`); d.start(name) }
    await expect(deleteEmulatorWallet(d.deps, { name: 'pin-wallet' })).rejects.toThrow('is running')
    expect(d.calls).toEqual(['prepare pin-wallet'])
  })
  test("Settings' Delete Flash (stopIfRunning) stops it first, then erases", async () => {
    const d = deletion('pin-wallet')
    await deleteEmulatorWallet(d.deps, { name: 'pin-wallet', stopIfRunning: true })
    expect(d.calls).toEqual(['prepare pin-wallet', 'stop pin-wallet', 'erase pin-wallet'])
  })
  test('a wallet that is not running is erased without stopping anything', async () => {
    const d = deletion('pin-wallet')
    await deleteEmulatorWallet(d.deps, { name: 'signing-wallet' })
    expect(d.calls).toEqual(['prepare signing-wallet', 'erase signing-wallet'])
  })
})
