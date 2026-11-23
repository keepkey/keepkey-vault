import { expect, test } from 'bun:test'

test('SendForm: the review shows the fee in USD from the native price (Jasper audit v6 B13)', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/send-form-fee-usd.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode !== 0) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({ native: '0.00021 ETH0.63', subCent: '1.3e-7 ETH<0.01', unpriced: '0.00021 ETH', token: '0.00021 ETH0.63' })
}, 35000)
