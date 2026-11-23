import { expect, test } from 'bun:test'

test('the Multisig tab loads existing Safes automatically and follows wallet identity changes', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/safe-discovery-ui.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    autoLoaded: true, changedOwnersRequireReview: true, manualRefresh: true, walletSwitchHidesSafe: true, noSigning: true,
  })
}, 35000)
