import { expect, test } from 'bun:test'

test('swap explorer links use the saved source chain, including token swaps, and fail closed without it', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/swap-row-explorer.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 15000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    correctNetworks: 7, unavailableIdentities: 5, rowSelection: true,
  })
}, 20000)
