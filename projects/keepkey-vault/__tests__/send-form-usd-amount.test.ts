import { expect, test } from 'bun:test'

test('SendForm: a USD amount converts to no more decimals than the asset allows (Jasper audit v5 V2)', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/send-form-usd-amount.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({ truncate: true, btc: '0.00012676', usdc: '10.003' })
}, 35000)
