import { expect, test } from 'bun:test'

test('Zcash send UI admits host-qualified signers and revokes retired or disabled sessions', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/send-zcash-readiness.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    physicalVersions: 2, qualifiedEmulator: true, alphaDisabled: true, staleStatus: true,
    immediateRevocation: true, unlockPreservesReview: true, retiredSigning: true,
    ownerScope: true, otherChain: true, unmounted: true, statusFailure: true,
    malformedStatus: true, firstDevicePush: true, settingsPending: true, settingsFailure: true, settingsSaved: true,
    qualifiedPhysical: true, physicalUnlockPreservesReview: true, physicalHashRevocation: true,
    physicalSessionRevocation: true, physicalTransportRevocation: true, malformedPhysicalStatus: true, explicitEmulator: true, broadcasts: 0,
  })
}, 35_000)
