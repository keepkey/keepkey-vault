import { expect, test } from 'bun:test'

test('ZEC swap inputs quote exact native units despite provider precision metadata', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/swap-dialog-amount-precision.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  })
  const stdout = run.stdout.toString()
  if (run.exitCode !== 0) throw new Error(run.stderr.toString() || stdout)
  const marker = 'SWAP_DIALOG_AMOUNT_PRECISION_RESULT '
  const records = stdout.split(/\r?\n/).filter(line => line.startsWith(marker))
  if (records.length !== 1) throw new Error(`Expected one amount fixture result, received ${records.length}\n${stdout}`)
  const nativeQuote = (amount: string, isMax = false) => ({ fromCaip: 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133', toCaip: 'eip155:1/slip44:60', amount, isMax })
  expect(JSON.parse(records[0].slice(marker.length))).toEqual({
    defaultQuote: nativeQuote('0.00081'), usdQuote: nativeQuote('0.00081'), usdInput: { inputMode: 'fiat', fiatAmount: '1' },
    maxQuote: nativeQuote('0.12345678', true), explicitExcess: { rpcCalls: 0, invalid: 'true', warning: true },
    trailingZeroQuote: nativeQuote('0.12345678'), noSigningDeviceOrNetwork: true,
  })
}, 35_000)
