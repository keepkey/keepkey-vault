import { expect, test } from 'bun:test'

test('review depth preserves consent, firmware refusal, cancellation and frame isolation', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/signing-review-ui.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({ consent: true, refused: true, cancel: true, frames: true, overview: true })
}, 35000)
