import { expect, test } from 'bun:test'

test('BTC receive hides the path editor so the QR and the device check share one path (audit v6 U1)', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/btc-receive-path.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    bitcoin: 'false',
    litecoin: 'true',
    ethereum: 'true',
  })
}, 35000)
