import { expect, test } from 'bun:test'

test('Magi dialog: firmware gate, quote-id-only execution, BTC deposit on continue, retry from Magi balance, own BTC address prefill', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/magi-swap-ui.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({ blocked: true, execute: true, btcIn: true, attention: true, btcOut: true })
}, 35000)
