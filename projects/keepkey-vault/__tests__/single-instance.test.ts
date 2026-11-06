/**
 * B6: a second KeepKey Desktop must not come up half-started.
 *
 * Before: the REST port check ran after the main window opened, and only with
 * the REST API on. A second copy showed its window and then blocked in the
 * port-in-use alert (the bun thread waits on the modal), so it looked like a
 * UI with no backend. With the REST API off it started fully, beside the first.
 *
 * Now the copy that starts first listens on a unix socket; a later copy asks it
 * to come to the front and quits before it opens a window.
 *
 * Run: bun test __tests__/single-instance.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimSingleInstance, type InstanceClaim } from '../src/bun/single-instance'
import { refuseSecondDesktop } from '../src/bun/rest-api-startup'

const dirs: string[] = []
const claims: InstanceClaim[] = []
// Unix socket paths are limited to ~104 bytes on macOS: keep them short.
const socketPath = () => { const dir = mkdtempSync(join(tmpdir(), 'kk-si-')); dirs.push(dir); return join(dir, 'd.sock') }
afterEach(() => {
  for (const claim of claims.splice(0)) if (claim.role === 'primary') claim.release()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const claim = async (path: string, onFocus: () => void, timeoutMs?: number) => {
  const result = await claimSingleInstance(path, onFocus, timeoutMs)
  claims.push(result)
  return result
}

describe('one KeepKey Desktop at a time', () => {
  test('the first copy owns the instance; a second one brings it to the front instead of starting', async () => {
    const path = socketPath()
    let focused = 0
    expect((await claim(path, () => focused++)).role).toBe('primary')
    const started = Date.now()
    expect((await claim(path, () => { throw new Error('the second copy must not own the socket') })).role).toBe('focused-existing')
    expect(focused).toBe(1)
    expect(Date.now() - started).toBeLessThan(1000)
    // A third launch does the same: the first copy still owns the socket.
    expect((await claim(path, () => {})).role).toBe('focused-existing')
    expect(focused).toBe(2)
  })

  test('a socket file left by a copy that crashed is replaced, not mistaken for a running Desktop', async () => {
    const path = socketPath()
    const crashed = Bun.spawnSync([process.execPath, '-e',
      `Bun.listen({ unix: ${JSON.stringify(path)}, socket: { data() {} } }); process.exit(0)`])
    expect(crashed.exitCode).toBe(0)
    expect(existsSync(path)).toBe(true)
    let focused = 0
    expect((await claim(path, () => focused++)).role).toBe('primary')
    expect((await claim(path, () => {})).role).toBe('focused-existing')
    expect(focused).toBe(1)
  })

  test('a running copy that does not answer is reported, within the timeout, and is not replaced', async () => {
    const path = socketPath()
    const silent = Bun.listen({ unix: path, socket: { data() { /* never answers */ } } })
    try {
      const started = Date.now()
      expect((await claim(path, () => {}, 300)).role).toBe('unresponsive')
      expect(Date.now() - started).toBeLessThan(1500)
      expect(existsSync(path)).toBe(true)
    } finally { silent.stop(true) }
  })

  test('first run: the folder for the socket does not exist yet', async () => {
    const path = join(socketPath().replace(/d\.sock$/, ''), 'new', 'd.sock')
    expect((await claim(path, () => {})).role).toBe('primary')
    expect(existsSync(path)).toBe(true)
  })

  test('released on quit: the next launch starts normally', async () => {
    const path = socketPath()
    const first = await claimSingleInstance(path, () => {})
    expect(first.role).toBe('primary')
    if (first.role === 'primary') first.release()
    expect((await claim(path, () => {})).role).toBe('primary')
  })
})

describe('an older Desktop on the port (no instance socket)', () => {
  test('is refused with the startup dialog, then this copy quits', async () => {
    const shown: string[] = []
    const exits: number[] = []
    await refuseSecondDesktop(1646, { answersLikeDesktop: async () => true, showError: async d => { shown.push(d.message) }, exit: code => { exits.push(code) } })
    expect(shown).toEqual(["KeepKey Desktop can't start: port 1646 is in use"])
    expect(exits).toEqual([1])
  })
  test('a free port shows nothing and starts', async () => {
    const exits: number[] = []
    await refuseSecondDesktop(1646, { answersLikeDesktop: async () => false, showError: async () => { throw new Error('no dialog') }, exit: code => { exits.push(code) } })
    expect(exits).toEqual([])
  })
})

describe('Desktop claims the instance before it opens a window', () => {
  const index = readFileSync(join(import.meta.dir, '..', 'src/bun/index.ts'), 'utf8')
  test('the claim and the older-Desktop port probe both run before the main BrowserWindow is created', () => {
    const window = index.indexOf('const mainWindow = new BrowserWindow(')
    const claimAt = index.indexOf('await claimSingleInstance(')
    const probeAt = index.indexOf('await refuseSecondDesktop(')
    expect(window).toBeGreaterThan(0)
    expect(claimAt).toBeGreaterThan(0)
    expect(probeAt).toBeGreaterThan(0)
    expect(claimAt).toBeLessThan(window)
    expect(probeAt).toBeLessThan(window)
  })
  test('a copy that handed off quits, and a silent one is told why', () => {
    expect(/role === 'focused-existing'[\s\S]{0,300}process\.exit\(0\)/.test(index)).toBe(true)
    expect(/role === 'unresponsive'[\s\S]{0,300}SECOND_INSTANCE_UNRESPONSIVE[\s\S]{0,200}process\.exit\(1\)/.test(index)).toBe(true)
  })
})
