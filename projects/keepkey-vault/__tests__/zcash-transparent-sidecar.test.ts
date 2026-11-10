import { beforeAll, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

let result: any
beforeAll(async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./support/zcash-transparent-sidecar.ts', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdout: 'pipe', stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill(), 10000)
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  if (code) throw new Error(err || out)
  result = JSON.parse(out.trim().split('\n').at(-1)!)
}, 15000)

test('old unqualified builders fail before any process launch', () => {
  expect(result.oldBinary).toContain('updated Zcash Nu7 transaction builder')
  expect(result.oldBinaryLaunches).toBe(0)
})
test('qualified native startup explicitly selects the profile-free transparent mode', () => {
  expect(result.native.ready).toBe(true)
  expect(result.native.argv.at(-1)).toBe('--transparent-only')
})
test('old running or concurrent profile-mode startup cannot be accepted, killed or silently restarted', () => {
  expect(result.profileMode).toContain('running Zcash builder')
  expect(result.profilePreserved).toBe(true)
  expect(result.concurrent).toContain('running Zcash builder')
  expect(result.concurrentPreserved).toBe(true)
})
test('a new native process without its promised ready capability is retired', () => {
  expect(result.badReady).toContain('does not support Nu7')
  expect(result.badReadyRetired).toBe(true)
})
test('an already qualified modern profile process is reused without another process or profile startup', () => {
  expect(result.modernProfileReused).toBe(true)
})
test('replacing the binary and its valid manifest cannot retroactively qualify a running process', () => {
  expect(result.changedBinary).toContain('has not been qualified')
  expect(result.changedBinaryPreserved).toBe(true)
})
