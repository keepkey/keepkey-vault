// The Address Book always shows every network: no filter row, no hidden recipients.
import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

test('recipients on different chains all show and no network filter is offered', () => {
  const run = Bun.spawnSync([process.execPath, fileURLToPath(new URL('./support/addressbook-all-networks.tsx', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({ offersNetworkFilter: false, showsEveryRecipient: true })
}, 35000)
