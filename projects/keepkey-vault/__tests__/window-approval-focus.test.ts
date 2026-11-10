import { beforeAll, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

let results: Record<string, any>
beforeAll(async () => {
  // Native app startup is intentionally never imported. The child executes the
  // production callbacks and REST router with a fake window, real AuthStore,
  // Request/AbortSignal objects and no native HTTP sockets.
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./support/window-approval-focus.ts', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdout: 'pipe', stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill(), 25_000)
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  if (code !== 0) throw new Error(stderr || stdout || `Focus fixture exited ${code}`)
  results = JSON.parse(stdout.trim().split('\n').at(-1)!)
}, 30_000)

test('launch and automatic device work cannot claim always-on-top ownership', () => {
  expect(results.approvalOwners).toEqual([])
  expect(results.launch).toEqual({ elevated: false, calls: [] })
  expect(results.manualOverride).toBe(false)
})

test('explicit PIN unlock remains quiet while pending and after completion', () => {
  expect(results.pin).toEqual({ pending: { refs: 0, alwaysOnTop: false }, done: { refs: 0, alwaysOnTop: false }, calls: [] })
})

test('health, cache-only reads and a foreground read waiting for PIN never elevate the window', () => {
  expect(results.reads).toEqual({ health: 200, cacheMiss: 423, cacheLeases: 0, pending: { refs: 0, alwaysOnTop: false }, foreground: 200, foregroundLeases: 1, calls: [] })
})

test.each(['approve', 'reject', 'abort', 'timeout'])('signing approval owns focus only until %s', outcome => {
  expect(results[`sign-${outcome}`]).toEqual({ pending: { refs: 1, alwaysOnTop: true }, approved: outcome === 'approve', done: { refs: 0, alwaysOnTop: false }, calls: [true, 'focus', false] })
})

test.each(['approve', 'reject', 'timeout'])('pairing dialog releases focus on %s', outcome => {
  expect(results[`pair-${outcome}`]).toEqual({ pending: { refs: 1, alwaysOnTop: true }, status: outcome === 'approve' ? 200 : 500, done: { refs: 0, alwaysOnTop: false }, calls: [true, 'focus', false] })
})

test('overlapping signing and pairing approvals keep the remaining dialog elevated', () => {
  expect(results.overlap).toEqual({ both: { refs: 2, alwaysOnTop: true }, afterSign: { refs: 1, alwaysOnTop: true }, done: { refs: 0, alwaysOnTop: false }, calls: [true, 'focus', false] })
})

test('WalletConnect signing and pairing use the same balanced approval ownership', () => {
  expect(results.walletConnect).toEqual({ both: { refs: 2, alwaysOnTop: true }, afterPair: { refs: 1, alwaysOnTop: true }, approved: false, done: { refs: 0, alwaysOnTop: false }, calls: [true, 'focus', false] })
})
