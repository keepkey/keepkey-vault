import { expect, test } from 'bun:test'

test('SendForm: MAX review and fee check work with a trailing space after the recipient (Jasper audit v5 V5)', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/send-form-max-recipient.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({ reviewAmount: true, maxPlaceholder: false, feeWarning: true })
}, 35000)
