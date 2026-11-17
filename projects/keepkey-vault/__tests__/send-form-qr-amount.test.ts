import { expect, test } from 'bun:test'

test('SendForm: a scanned QR amount replaces a USD figure, and EIP-681 value= is wei (Jasper audit v5 V3)', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/send-form-qr-amount.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({ usdMode: true, eip681Wei: true, tokenIgnoresValue: true })
}, 35000)
