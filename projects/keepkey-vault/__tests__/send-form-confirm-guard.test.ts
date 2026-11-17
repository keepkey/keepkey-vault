import { expect, test } from 'bun:test'

test('SendForm: burn/self-send confirmations are keyed to the recipient and enforced in handleBuild (Jasper audit v5 V9)', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/send-form-confirm-guard.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode !== 0) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({ staleClickBuilds: 0, confirmedBuilds: 1, selfSendReconfirm: true, directGuard: true, recipientRoundTrip: true, qrReconfirm: true, sameQrReconfirm: true, chainRoundTrip: true, accountRoundTrip: true, assetRoundTrip: true, destinationRecheck: true })
}, 35000)
