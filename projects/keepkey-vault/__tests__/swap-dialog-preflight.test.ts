import { expect, test } from 'bun:test'

test('swap dialog on the preflight console at 1200×800: one-surface form, review with the route art, signing with the KeepKey on the left', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/swap-dialog-preflight.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 60000,
  })
  const line = run.stdout.toString().split('\n').find(l => l.startsWith('SWAP_PREFLIGHT_RESULT '))
  if (!line) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(line.slice('SWAP_PREFLIGHT_RESULT '.length))).toEqual({
    formOneSurface: true, formAssetsNamed: true, formNoIdsOnScreen: true, formNoNativeBadge: true, formSlippageSegmented: true, formReviewPillPinned: true,
    reviewRouteArt: true, reviewNoDiscs: true, reviewAmountLine: true, reviewTerms: true, reviewChecklist: true, reviewNoIdsOnScreen: true, reviewActionPinned: true,
    signingDeviceLeft: true, signingCancelPinned: true,
  })
}, 65000)
