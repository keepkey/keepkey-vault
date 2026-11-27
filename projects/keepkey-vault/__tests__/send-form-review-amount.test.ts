import { expect, test } from 'bun:test'

test('SendForm review: the amount exactly as the KeepKey prints it, then ≈ rounded; TON max shows the amount built (KEEPKEY-126, KEEPKEY-76)', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/send-form-review-amount.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({ tonMax: true, btcDevice: true, btcApprox: true, ethAll18: true })
}, 35000)
