import { expect, test } from 'bun:test'

test('a resumed swap keeps its broadcast time, check status and settlement terms', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/swap-dialog-tracking.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 60000,
  })
  const stdout = run.stdout.toString()
  if (run.exitCode !== 0) throw new Error(run.stderr.toString() || stdout)
  const marker = 'SWAP_DIALOG_TRACKING_RESULT '
  const records = stdout.split(/\r?\n/).filter(line => line.startsWith(marker))
  if (records.length !== 1) throw new Error(`Expected one swap dialog fixture result, received ${records.length}\n${stdout}`)
  expect(JSON.parse(records[0].slice(marker.length))).toEqual({
    elapsedFromBroadcast: true,
    remainingFromBroadcast: true,
    failedCheckShown: true,
    recheckClearsFailure: true,
    settledAboveMinimum: true,
  })
})
