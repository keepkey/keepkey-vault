import { beforeAll, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

let results: Record<string, any>
beforeAll(async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./support/rest-zcash-admission.ts', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdout: 'pipe', stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill(), 20_000)
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  if (exit) throw new Error(err || out || `REST admission fixture exited ${exit}`)
  results = JSON.parse(out.trim().split('\n').at(-1)!)
}, 25_000)

test.each(['locked', 'unlocked', 'no-device', 'no-approval-callback', 'forged-modern-plan', 'case-variation', 'incomplete-zcash'])('%s REST Zcash signing rejects before approval or device admission', name => {
  expect(results[name].status).toBe(501)
  expect(results[name].data.error).toContain('Desktop')
  expect(results[name].data.error).toContain('7.17 alpha emulator')
  expect(results[name].counts).toEqual({ acquisitions: 0, unlocks: 0, approvals: 0, reads: 0, signs: 0, releases: 0 })
})

test('authentication still precedes the Zcash capability response', () => {
  expect(results.unauthenticated.status).toBe(401)
  expect(results.unauthenticated.counts).toEqual({ acquisitions: 0, unlocks: 0, approvals: 0, reads: 0, signs: 0, releases: 0 })
})

test.each(['bitcoin', 'bitcoin-default'])('%s still unlocks, approves and dispatches exactly one synthetic BTC signature', name => {
  expect(results[name].status).toBe(200)
  expect(results[name].data.serializedTx).toBe('01000000000000000000')
  expect(results[name].counts).toEqual({ acquisitions: 1, unlocks: 1, approvals: 1, reads: 0, signs: 1, releases: 1 })
  expect(results[name].signedCoin).toBe('Bitcoin')
})
