import { expect, test } from 'bun:test'

test('a changed Safe stays blocked until its current contract and all owners are explicitly reviewed', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/vault-owner-review.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    initialBlocked: true, prefilledAddress: '0x6717d97655d8fC9d05C2DD3F28b54f574309B473',
    fifthSignerShown: true, writesBeforeConfirmation: 0, verifiedAfterReview: true, writes: 1,
    calls: ['vaultAccountGet', 'vaultAddPreview', 'vaultAddConfirm', 'vaultAccountGet'],
  })
}, 35000)
