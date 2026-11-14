import { expect, test } from 'bun:test'

test('the native coin page keeps its on-chain balance through degraded pushes and refreshes (audit v4 H7), priced like the sidebar (H18)', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/asset-page-native-proof.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    firstRead: { reads: 1, onChain: true, unverified: false },
    afterDegradedPush: { reads: 2, onChain: true, unverified: false },
    afterDegradedRefresh: { found: true, reads: 3, onChain: true, unverified: false },
    repricedHeader: { sidebarPrice: true, ownerOldPrice: false },
  })
}, 35000)
