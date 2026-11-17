import { expect, test } from 'bun:test'

test('SendForm: a QR label= is not a memo, and XRP reads only dt= (Jasper audit v5 V4)', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/send-form-qr-memo.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    xrpLabel: '', xrpTag: '104857', xrpBareTag: '7', xrpMemoIgnored: '', cosmosLabel: '', cosmosMemo: '12345',
  })
}, 35000)
