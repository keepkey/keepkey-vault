import { expect, test } from 'bun:test'

test('SendForm fences retired RPCs, preserves same-owner drafts, and distinguishes pending balances', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/send-form-requests.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    senderReadiness: true, retiredBuild: true, editedBuild: true, identities: 6, retiredSignature: true, signingIdentities: 2,
    snapshot: true, unmounted: true, pendingBalance: true,
  })
}, 35000)
