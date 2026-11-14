import { expect, test } from 'bun:test'

test('SendForm: network gas quote, token fee warning, risky recipients, MAX review amount, comma decimals, one broadcast per double-click', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/send-form-safety.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    customGasQuote: true, tokenFeeWarning: true, recipientRisk: 5, maxReview: true, commaDecimal: true, doubleClickBroadcasts: 1,
  })
}, 35000)
