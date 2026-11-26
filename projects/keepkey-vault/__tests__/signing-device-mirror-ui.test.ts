import { expect, test } from 'bun:test'

test('signing dialog mirrors the KeepKey screen for Hive message, vote and custom_json; others keep the sketch; follows each ButtonRequest', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/signing-device-mirror-ui.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({ message: true, vote: true, customJson: true, fallback: true, follows: true, range: true })
}, 35000)
