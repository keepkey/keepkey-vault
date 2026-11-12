import { expect, test } from 'bun:test'

test('a busy KeepKey is waited out and an aged quote never interrupts the approval', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/swap-dialog-device-wait.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 90000,
  })
  const stdout = run.stdout.toString()
  if (run.exitCode !== 0) throw new Error(run.stderr.toString() || stdout)
  const marker = 'SWAP_DIALOG_DEVICE_WAIT_RESULT '
  const records = stdout.split(/\r?\n/).filter(line => line.startsWith(marker))
  if (records.length !== 1) throw new Error(`Expected one swap dialog fixture result, received ${records.length}\n${stdout}`)
  expect(JSON.parse(records[0].slice(marker.length))).toEqual({
    previewWaitsOutBusyDevice: true,
    previewBusyNeverShown: true,
    executeWaitsOutBusyDevice: true,
    agedQuoteRequotedOnce: true,
    payloadBuiltOnlyForFreshQuote: true,
    reviewAsksForOneConfirm: true,
    expiryAndBusyNeverShown: true,
    cancelEndsDeviceWait: true,
    cancelMessageKept: true,
    agedConfirmRefreshesWithoutExecuting: true,
    otherErrorsSurface: true,
  })
}, 95000)
