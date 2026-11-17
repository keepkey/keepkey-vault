import { expect, test } from 'bun:test'

test('SendForm: self-send warning catches uppercase bech32 and BCH without prefix (Jasper audit v5 V6)', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/send-form-self-send-match.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode !== 0) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    btcUppercase: true, bchNoPrefix: true, bchPrefixAdded: true, bchUppercase: true, evmCase: true, otherAddress: false, base58Distinct: false,
  })
}, 35000)
