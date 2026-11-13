import { expect, test } from 'bun:test'
import { activityBalanceTarget, createPostTxBalanceRefresh, POST_TX_BALANCE_DELAYS_MS, type BalanceRefreshScope } from '../src/bun/post-tx-balance'
import { CHAINS } from '../src/shared/chains'
import type { ApiLogEntry } from '../src/shared/types'

const broadcast: ApiLogEntry = { method: 'RPC', route: 'broadcastTx', status: 200, timestamp: 1, durationMs: 0,
  activityType: 'broadcast', txid: 'source-tx', chain: 'LTC', sessionEpoch: 1,
  responseBody: { chainId: 'litecoin', caip: 'bip122:12a765e31ffd4059bada1e25190f6e98/slip44:2' } }
function harness(refresh?: (params: any, isCurrent: () => boolean) => Promise<unknown>) {
  let clock = 0, ready = true
  let scope: BalanceRefreshScope | null = { epoch: 1, deviceId: 'device-A', walletId: 'wallet-A', wallet: {} }
  const timers: Array<{ fn: () => void; due: number; cleared?: boolean }> = [], requests: any[] = [], errors: unknown[] = []
  const worker = createPostTxBalanceRefresh({ getScope: () => scope, canRefresh: () => ready,
    refresh: async (params, isCurrent) => { requests.push(params); return refresh?.(params, isCurrent) },
    onError: (_chain, error) => errors.push(error),
    setTimer: (fn, ms) => { const timer = { fn, due: clock + ms }; timers.push(timer); return timer }, clearTimer: timer => { (timer as any).cleared = true } })
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  async function tick() {
    const timer = timers.filter(timer => !timer.cleared).sort((a, b) => a.due - b.due)[0]
    if (!timer) return null
    timer.cleared = true
    const delay = timer.due - clock; clock = timer.due; timer.fn(); await flush(); return delay
  }
  return { worker, requests, errors, tick, flush, setReady: (value: boolean) => { ready = value }, setScope: (value: BalanceRefreshScope | null) => { scope = value } }
}

test('successful broadcast forces its chain directly and retries until the indexer catches up, then stops', async () => {
  const indexed = ['0.2', '0.2', '0.1', '0.1'], pushed: string[] = []
  const h = harness(async (_params, isCurrent) => { const balance = indexed.shift()!; if (isCurrent()) pushed.push(balance) })
  expect(h.worker.activity(broadcast, CHAINS)).toBe(true)
  for (const delay of POST_TX_BALANCE_DELAYS_MS) expect(await h.tick()).toBe(delay)
  expect(h.requests).toEqual(POST_TX_BALANCE_DELAYS_MS.map(() => ({ chainId: 'litecoin', forceRefresh: true })))
  expect(pushed).toEqual(['0.2', '0.2', '0.1', '0.1'])
  expect(h.worker.size()).toBe(0)
  expect(await h.tick()).toBeNull()
})

test('a confirmation starts a fresh forced read after the broadcast retries have ended', async () => {
  const h = harness()
  h.worker.activity(broadcast, CHAINS)
  for (const _ of POST_TX_BALANCE_DELAYS_MS) await h.tick()
  h.worker.request('litecoin', broadcast.txid)
  expect(await h.tick()).toBe(0)
  expect(h.requests).toHaveLength(5)
  expect(h.requests[4]).toEqual({ chainId: 'litecoin', forceRefresh: true })
})

test('only successful broadcasts schedule reads and older REST entries can resolve their unique chain', async () => {
  const h = harness()
  for (const entry of [{ ...broadcast, status: 500 }, { ...broadcast, activityType: 'sign' }, { ...broadcast, txid: undefined },
    { ...broadcast, sessionEpoch: 0 }, { ...broadcast, walletId: 'wallet-B' }, { ...broadcast, deviceId: 'device-B' },
    { ...broadcast, responseBody: { ...broadcast.responseBody, shielded: true } }]) expect(h.worker.activity(entry as ApiLogEntry, CHAINS)).toBe(false)
  expect(await h.tick()).toBeNull()
  expect(activityBalanceTarget({ ...broadcast, method: 'POST', responseBody: {} }, CHAINS)?.chainId).toBe('litecoin')
  expect(activityBalanceTarget({ ...broadcast, responseBody: {}, chain: 'ETH' }, CHAINS)).toBeUndefined()
})

test('disconnect and wallet switches cancel both queued reads and an in-flight balance push', async () => {
  let finish!: () => void
  const pushed: string[] = []
  const h = harness(async (_params, isCurrent) => { await new Promise<void>(resolve => { finish = resolve }); if (isCurrent()) pushed.push('old-wallet') })
  h.worker.activity(broadcast, CHAINS)
  await h.tick()
  h.worker.clear()
  h.setScope({ epoch: 2, deviceId: 'device-A', walletId: 'wallet-B', wallet: {} })
  finish(); await h.flush()
  expect(pushed).toEqual([])
  expect(await h.tick()).toBeNull()
  expect(h.worker.size()).toBe(0)
})

test('a newer same-chain trigger supersedes an in-flight result and coalesces the next read', async () => {
  const finishes: Array<() => void> = [], pushed: number[] = []
  let index = 0
  const h = harness(async (_params, isCurrent) => { const current = ++index; await new Promise<void>(resolve => finishes.push(resolve)); if (isCurrent()) pushed.push(current) })
  h.worker.activity(broadcast, CHAINS); await h.tick()
  h.worker.request('litecoin', 'confirmed-tx'); await h.tick()
  expect(h.requests).toHaveLength(1)
  finishes[0](); await h.flush(); expect(pushed).toEqual([])
  expect(await h.tick()).toBe(0)
  finishes[1](); await h.flush(); expect(pushed).toEqual([2])
  h.worker.clear()
})

test('errors and a temporarily locked device consume a bounded retry budget', async () => {
  const h = harness(async () => { throw new Error('Indexer unavailable') })
  h.setReady(false); h.worker.activity(broadcast, CHAINS); await h.tick()
  expect(h.requests).toEqual([])
  h.setReady(true)
  for (const _ of POST_TX_BALANCE_DELAYS_MS.slice(1)) await h.tick()
  expect(h.errors).toHaveLength(3)
  expect(await h.tick()).toBeNull()
})

// Audit v4 H9: a broadcast scheduled from inside a Desktop device operation
// leaked that finished operation's fence into the refresh, so the first device
// read threw "The KeepKey wallet changed" and the balance never refreshed.
test('refresh does not inherit the broadcasting device operation or REST request', async () => {
  const { deviceOperationContext } = await import('../src/bun/device-operation')
  const { restRequest } = await import('../src/bun/device-gate')
  const seen: unknown[] = []
  const scope = { epoch: 1, deviceId: 'd', walletId: 'w', wallet: {} }
  const worker = createPostTxBalanceRefresh({
    getScope: () => scope, canRefresh: () => true,
    refresh: async () => { seen.push(deviceOperationContext.getStore(), restRequest.getStore()) },
  })
  restRequest.run({} as any, () => deviceOperationContext.run({ assertCurrent: () => { throw new Error('The KeepKey wallet changed') } },
    () => worker.activity(broadcast, CHAINS)))
  await new Promise(resolve => setTimeout(resolve, 10))
  worker.clear()
  expect(seen.length).toBe(2)
  expect(seen).toStrictEqual([undefined, undefined])
})
