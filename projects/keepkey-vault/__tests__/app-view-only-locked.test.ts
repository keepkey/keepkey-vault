import { expect, test } from 'bun:test'

// Audit v4 H4: App wiring around a locked KeepKey. app-phase.test.ts covers the
// predicates; this drives the real App: auto PIN prompt, Cancel, "Open view-only".
test('a locked KeepKey keeps "Open view-only" open, never re-prompts the PIN over it, and ends it once unlocked', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/app-view-only-locked.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 60000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    pluggedInLocked: { unlockRequests: 1, view: null },
    viewOnlyAfterCancel: { unlockRequests: 1, view: 'view-only' },
    stillLocked: { unlockRequests: 1, view: 'view-only' },
    replugLocked: { unlockRequests: 1, view: 'view-only' },
    unlockedOnDevice: { view: null },
  })
}, 65000)
