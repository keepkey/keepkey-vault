import { expect, test } from 'bun:test'

test('address-book owners, KeepKey approval, sharing and web approval reach a separate execution review', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/safe-web-practice.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    pickerChecked: true, prepared: true, shared: true, approvals: 2, executionReviews: 1, noBroadcast: true,
  })
}, 35000)
