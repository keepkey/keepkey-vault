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

test.each(['swap-zcash-locked', 'swap-zcash-unlocked', 'swap-zcash-no-device', 'swap-zcash-no-approval-callback'])('%s rejects its validated Zcash source before wallet acquisition or approval', name => {
  expect(results[name].status).toBe(501)
  expect(results[name].data.error).toContain('Desktop')
  expect(results[name].counts).toEqual({ acquisitions: 0, unlocks: 0, approvals: 0, reads: 0, signs: 0, releases: 0 })
})

test.each(['swap-forged-source-chain', 'swap-forged-source-caip'])('%s cannot change the canonical source of a saved quote', name => {
  expect(results[name].status).toBe(409)
  expect(results[name].counts).toEqual({ acquisitions: 0, unlocks: 0, approvals: 0, reads: 0, signs: 0, releases: 0 })
})

test('swap authentication still precedes capability responses', () => {
  expect(results['swap-zcash-unauthenticated'].status).toBe(401)
  expect(results['swap-zcash-unauthenticated'].counts).toEqual({ acquisitions: 0, unlocks: 0, approvals: 0, reads: 0, signs: 0, releases: 0 })
})

test('a Bitcoin source paying out to Zcash still unlocks, approves and executes exactly once', () => {
  const result = results['swap-bitcoin-to-zcash']
  expect(result.status).toBe(200)
  expect(result.counts).toEqual({ acquisitions: 1, unlocks: 1, approvals: 1, reads: 0, signs: 1, releases: 1 })
})

test('empty swap probes retain their existing gate diagnostic without acquiring the wallet', () => {
  const result = results['swap-empty-probe']
  expect(result.status).toBe(400)
  expect(result.data.error).toContain('Missing signing payload')
  expect(result.counts).toEqual({ acquisitions: 0, unlocks: 0, approvals: 0, reads: 0, signs: 0, releases: 0 })
})
