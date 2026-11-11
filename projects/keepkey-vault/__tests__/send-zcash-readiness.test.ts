import { expect, test } from 'bun:test'

test('actual Zcash send UI shows the host refusal, admits physical 7.16 and the alpha emulator, and revokes stale readiness', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/send-zcash-readiness.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    refusalCopy: 5, physicalAdmitted: true, qualifiedEmulator: true, alphaDisabled: true, staleStatus: true,
    immediateRevocation: true, unlockPreservesReview: true, retiredSigning: true,
    ownerScope: true, otherChain: true, unmounted: true, statusFailure: true,
    malformedStatus: true, firstDevicePush: true, settingsPending: true, settingsFailure: true, settingsSaved: true, broadcasts: 0,
  })
}, 35_000)
