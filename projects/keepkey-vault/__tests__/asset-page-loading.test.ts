import { beforeAll, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

let result: any
beforeAll(async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./support/asset-page-loading.tsx', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdout: 'pipe', stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill(), 25000)
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  if (code) throw new Error(err || out)
  result = JSON.parse(out.trim().split('\n').at(-1)!)
}, 30000)

test('ETH waits for its selected owner without borrowing aggregate balances or reading Bitcoin', () => {
  expect(result.pending).toEqual({ loading: true, address: '', aggregateShown: false, status: true, btcReads: 0 })
  expect(result.loaded).toEqual({ address: result.owner, loading: false, aggregateShown: false, amountShown: true })
})

test('balance pushes and refreshes keep the same receive view and verified address', () => {
  expect(result.refresh).toEqual({ sameView: true, address: result.owner, amountShown: true, status: true })
  expect(result.missingOwner).toEqual({ address: '', aggregateShown: false })
  expect(result.purged).toEqual({ address: '', oldOwnerShown: false, aggregateShown: false })
})

test('watch-only addresses do not start either personal account manager', () => {
  expect(result.watchOnly).toEqual({ address: result.savedOwner, additionalEvmReads: 0, additionalBtcReads: 0 })
})

test('disabled and retired BTC hook reads cannot replace newer account pushes', () => {
  expect(result.btcDisabled).toBe(0)
  expect(result.btcPushWins).toBe('new-push')
  expect(result.btcRetired).toEqual({ accounts: [], loading: false })
})
