import { expect, test } from 'bun:test'

test('signing console fits a short window: decision row outside the scroll, device on the left in both phases, guide folded', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/signing-console-fit-ui.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({ shell: true, approveShort: true, confirmShort: true, approveTall: true })
}, 35000)
