import { expect, test } from 'bun:test'

test('actual Zcash send UI uses scoped host readiness and never authorizes physical or disabled-alpha sending', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/send-zcash-readiness.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    physicalVersions: 2, qualifiedEmulator: true, alphaDisabled: true, staleStatus: true,
    immediateRevocation: true, unlockPreservesReview: true, retiredSigning: true,
    ownerScope: true, otherChain: true, unmounted: true, statusFailure: true,
    malformedStatus: true, firstDevicePush: true, settingsPending: true, settingsFailure: true, settingsSaved: true, broadcasts: 0,
  })
}, 35_000)
