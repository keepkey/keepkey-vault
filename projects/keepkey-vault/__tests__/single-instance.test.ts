/**
 * B6: a second KeepKey Desktop of the same channel hands off instead of coming
 * up half-started; other channels keep running side by side.
 *
 * History: the REST port check ran after the main window opened, so a second
 * copy showed its window and then blocked in the port-in-use alert: a UI with
 * no backend (log 2026-11-06 18:55:08). The first fix (one ~/.keepkey socket)
 * was reviewed and found to: call a copy that was quitting, or busy for 2 s,
 * "not responding"; let two copies started together both claim it; and make
 * dev, stable and every DMG version hand off to each other.
 *
 * Run: bun test __tests__/single-instance.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { claimSingleInstance, instanceSocketPath, startupInstanceGate, type InstanceClaim } from '../src/bun/single-instance'
import { startRestApiOrReport } from '../src/bun/rest-api-startup'

const CLAIMANT = new URL('./support/instance-claimant.ts', import.meta.url).pathname
const dirs: string[] = []
const claims: InstanceClaim[] = []
const children: Array<ReturnType<typeof Bun.spawn>> = []
// Unix socket paths are limited to ~104 bytes on macOS: keep them short.
// macOS tmpdir() (/var/folders/…) is too long for one: use /tmp.
const home = () => { const dir = mkdtempSync(join('/tmp', 'kk-si-')); dirs.push(dir); return dir }
const socketIn = (dir: string, channel = 'stable') => instanceSocketPath(dir, 'com.keepkey.vault', channel)
afterEach(() => {
  for (const claim of claims.splice(0)) if (claim.role === 'primary') claim.release()
  for (const child of children.splice(0)) child.kill()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function claim(path: string, options: { version?: string; onFocus?: (v: string) => void; deadlineMs?: number } = {}) {
  const result = await claimSingleInstance(path, { version: options.version ?? '1.6.10', onFocusRequest: options.onFocus ?? (() => {}), deadlineMs: options.deadlineMs })
  claims.push(result)
  return result
}

/** Another Desktop in its own process; resolves once it printed `line`. */
function spawnClaimant(env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, CLAIMANT], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'inherit' })
  children.push(child)
  const lines: string[] = []
  const waiters: Array<{ match: (l: string) => boolean; resolve: (l: string) => void }> = []
  ;(async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk)
      let i: number
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1)
        lines.push(line)
        for (const w of waiters.splice(0)) { if (w.match(line)) w.resolve(line); else waiters.push(w) }
      }
    }
  })()
  const waitFor = (match: (l: string) => boolean) => new Promise<string>(resolve => {
    const seen = lines.find(match)
    if (seen) resolve(seen); else waiters.push({ match, resolve })
  })
  return { child, lines, waitFor }
}

describe('one KeepKey Desktop per channel', () => {
  test('a second copy of the same version brings the first to the front and reports its version', async () => {
    const path = socketIn(home())
    const focused: string[] = []
    expect((await claim(path, { onFocus: v => focused.push(v) })).role).toBe('primary')
    expect(await claim(path, { onFocus: () => { throw new Error('the second copy must not own the socket') } }))
      .toEqual({ role: 'focused-existing', runningVersion: '1.6.10' })
    expect(focused).toEqual(['1.6.10'])
  })

  test('a different channel (dev beside the installed app) is a different instance: both start', async () => {
    const dir = home()
    expect(socketIn(dir, 'dev')).not.toBe(socketIn(dir, 'stable'))
    expect((await claim(socketIn(dir, 'stable'))).role).toBe('primary')
    expect((await claim(socketIn(dir, 'dev'))).role).toBe('primary')
  })

  test('the socket and its lock are private to this user (0600)', async () => {
    const path = socketIn(home())
    await claim(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(path.replace(/\.sock$/, '.lock')).mode & 0o777).toBe(0o600)
  })

  test('first run: the folder for the socket does not exist yet', async () => {
    const path = instanceSocketPath(join(home(), 'fresh'), 'com.keepkey.vault', 'stable')
    expect((await claim(path)).role).toBe('primary')
    expect(existsSync(path)).toBe(true)
  })

  test('a lock and socket left by a copy that crashed are replaced', async () => {
    const path = socketIn(home())
    const crashed = Bun.spawnSync([process.execPath, CLAIMANT], { env: { ...process.env, CLAIM_PATH: path, HOLD_MS: '0' } })
    expect(crashed.exitCode).toBe(0)
    expect(existsSync(path.replace(/\.sock$/, '.lock'))).toBe(true) // exited without releasing
    expect((await claim(path)).role).toBe('primary')
  })

  test('released on quit: the next launch starts normally', async () => {
    const path = socketIn(home())
    const first = await claimSingleInstance(path, { version: '1', onFocusRequest: () => {} })
    expect(first.role).toBe('primary')
    if (first.role === 'primary') first.release()
    expect((await claim(path)).role).toBe('primary')
  })
})

describe('the copy already running is quitting or busy', () => {
  test('relaunch while it quits with a blocking cleanup (released after the stall): the new copy waits, then starts', async () => {
    const path = socketIn(home())
    const old = spawnClaimant({ CLAIM_PATH: path, BLOCK_MS: '1200', RELEASE: 'after-block' })
    await old.waitFor(l => l === 'blocking')
    await Bun.sleep(600)
    const started = Date.now()
    expect((await claim(path)).role).toBe('primary')
    expect(Date.now() - started).toBeLessThan(5000)
  }, 15_000)

  test('relaunch while it quits (released first, then the stall): the new copy starts', async () => {
    const path = socketIn(home())
    const old = spawnClaimant({ CLAIM_PATH: path, BLOCK_MS: '1200', RELEASE: 'before-block' })
    await old.waitFor(l => l === 'blocking')
    await Bun.sleep(300)
    expect((await claim(path)).role).toBe('primary')
  }, 15_000)

  test('a copy busy for 3 s (not quitting) is waited for and brought forward, not called unresponsive', async () => {
    const path = socketIn(home())
    const busy = spawnClaimant({ CLAIM_PATH: path, BLOCK_MS: '3000', RELEASE: 'never' })
    await busy.waitFor(l => l === 'blocking')
    expect(await claim(path)).toEqual({ role: 'focused-existing', runningVersion: '1.0.0' })
    await busy.waitFor(l => l === 'focused')
  }, 15_000)

  test('only a copy silent past the whole bound is reported unresponsive, and it is not replaced', async () => {
    const path = socketIn(home())
    const stuck = spawnClaimant({ CLAIM_PATH: path, BLOCK_MS: '4000', RELEASE: 'never' })
    await stuck.waitFor(l => l === 'blocking')
    const started = Date.now()
    expect((await claim(path, { deadlineMs: 1000 })).role).toBe('unresponsive')
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(existsSync(path)).toBe(true)
  }, 15_000)
})

describe('two copies started at the same moment', () => {
  test('exactly one claims the instance; the other hands off to it', async () => {
    for (let round = 0; round < 4; round++) {
      const path = socketIn(home())
      const a = spawnClaimant({ CLAIM_PATH: path, HOLD_MS: '3000' })
      const b = spawnClaimant({ CLAIM_PATH: path, HOLD_MS: '3000' })
      const roles = await Promise.all([a, b].map(c => c.waitFor(l => l.startsWith('{')).then(l => JSON.parse(l).role)))
      expect(roles.sort()).toEqual(['focused-existing', 'primary'])
    }
  }, 30_000)
})

describe('what a launch does with the claim', () => {
  const run = async (claimFor: (path: string) => Promise<unknown>, version: string, options: { deadlineMs?: number } = {}) => {
    const path = socketIn(home())
    await claimFor(path)
    const dialogs: Array<{ message: string; detail: string }> = []
    const exits: number[] = []
    const result = await startupInstanceGate({ path, version, onFocusRequest: () => {}, deadlineMs: options.deadlineMs,
      showDialog: async d => { dialogs.push(d) }, exit: code => { exits.push(code) } })
    if (result) claims.push(result)
    return { result, dialogs, exits }
  }

  test('nothing running: this copy is the instance, no dialog', async () => {
    const r = await run(async () => {}, '1.6.10')
    expect(r.result?.role).toBe('primary')
    expect(r.dialogs).toEqual([])
    expect(r.exits).toEqual([])
  })

  test('the same version running: it comes to the front and this copy quits quietly', async () => {
    const r = await run(path => claim(path, { version: '1.6.10' }), '1.6.10')
    expect(r.result).toBeNull()
    expect(r.dialogs).toEqual([])
    expect(r.exits).toEqual([0])
  })

  test('an older version running (a new DMG opened): this copy says the old one is still running and how to switch', async () => {
    const r = await run(path => claim(path, { version: '1.6.9' }), '1.6.10')
    expect(r.exits).toEqual([0])
    expect(r.dialogs).toHaveLength(1)
    expect(r.dialogs[0].message).toBe('KeepKey Desktop 1.6.9 is still running')
    expect(r.dialogs[0].detail).toContain('quit KeepKey Desktop 1.6.9')
    expect(r.dialogs[0].detail).toContain('1.6.10')
  })

  test('a copy that never answers: an honest dialog, then this copy quits', async () => {
    const path = socketIn(home())
    const stuck = spawnClaimant({ CLAIM_PATH: path, BLOCK_MS: '4000', RELEASE: 'never' })
    await stuck.waitFor(l => l === 'blocking')
    const dialogs: Array<{ message: string; detail: string }> = []
    const exits: number[] = []
    await startupInstanceGate({ path, version: '1.6.10', onFocusRequest: () => {}, deadlineMs: 800, showDialog: async d => { dialogs.push(d) }, exit: c => { exits.push(c) } })
    expect(exits).toEqual([1])
    expect(dialogs[0].message).toBe('KeepKey Desktop is already open but has not answered')
    expect(dialogs[0].detail).toContain('may be busy')
  }, 15_000)
})

describe('another channel holds the REST port', () => {
  test('startup hides this copy\'s window before the port dialog, then quits: never a UI with no backend', async () => {
    const order: string[] = []
    const result = await startRestApiOrReport(1646, 'startup', {
      start: () => { throw new Error('EADDRINUSE') },
      answersLikeDesktop: async () => true,
      hideWindow: () => { order.push('hide window') },
      showError: async d => { order.push(`dialog: ${d.message}`) },
      exit: code => { order.push(`exit ${code}`) },
    })
    expect(result).toBeNull()
    expect(order).toEqual(['hide window', "dialog: KeepKey Desktop can't start: port 1646 is in use", 'exit 1'])
  })
  test('Settings (REST turned on later) keeps the window: Desktop stays up with the REST API off', async () => {
    const order: string[] = []
    await startRestApiOrReport(1646, 'settings', {
      start: () => { throw new Error('EADDRINUSE') }, answersLikeDesktop: async () => true,
      hideWindow: () => { order.push('hide window') }, showError: async () => { order.push('dialog') }, exit: () => { order.push('exit') },
    })
    expect(order).toEqual(['dialog'])
  })
})

