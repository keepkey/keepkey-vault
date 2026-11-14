import { expect, test } from 'bun:test'

test('an unsent signature shows "Not sent" and can be discarded; a fresh signature, a signed message or a broadcast cannot', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/activity-not-sent.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 15000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    rowNotSent: true,
    freshRowNotSent: false,
    dialogNotSent: true,
    discard: { calls: [{ method: 'dismissActivity', params: { id: '42' } }], closed: 1 },
    // A fresh or message signature (status 'signed') may still go out, or never does: no "never saw broadcast".
    freshDiscard: false,
    broadcastDiscard: false,
  })
}, 20000)
