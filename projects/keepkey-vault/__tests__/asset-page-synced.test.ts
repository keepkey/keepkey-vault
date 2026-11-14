import { expect, test } from 'bun:test'

test('a cached balance older than the chain\'s last tx reads "Cached", never "Synced" (audit v4 H3)', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/asset-page-synced.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    confirmed: { synced: true, cached: false },
    olderThanLastTx: { synced: false, cached: true },
    txPendingPush: { cached: true, failed: false },
  })
}, 35000)
