import { expect, test } from 'bun:test'

test('Staking and Name registration wait on the KeepKey with no client timeout and a Cancel that reaches the device', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/device-signing-wait.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({ staking: true, names: true })
}, 35000)
