import { describe, expect, test } from 'bun:test'
import { createActiveWalletWatch, ownedWatchKey, refreshWatchedChain, selectOwnedWatches, type OwnedWatch } from '../src/bun/active-wallet-watch'
import type { BalanceRefreshScope } from '../src/bun/post-tx-balance'
import { utxoAccountScriptPaths } from '../src/bun/chain-scan'
import { CHAINS } from '../src/shared/chains'
import type { ChainBalance, RecentActivity } from '../src/shared/types'
import { BALANCE_CACHE_QUIET_WINDOW_MS } from '../src/shared/balance-cache-policy'
import { createChainBackoff } from '../src/bun/chain-backoff'
import { MAX_AUTO_RETRIES } from '../src/bun/active-wallet-watch'
const ltc = CHAINS.find(chain => chain.id === 'litecoin')!
const watches = [0, 1].flatMap(account => utxoAccountScriptPaths(ltc, account).map(path => ({ address: `${path.scriptType}-${path.path[0]}-${account}`, networkId: ltc.networkId, chainId: ltc.id, caip: ltc.caip, account: true, path: path.path.join('/') })))
function harness(refresh?: (hint: any, isCurrent: () => boolean) => Promise<void>, extra: Partial<Parameters<typeof createActiveWalletWatch>[0]> = {}) {
  let clock = 0, ready = true
  let scope: BalanceRefreshScope = { epoch: 1, deviceId: 'device', walletId: 'wallet-A', wallet: {} }
  const timers: Array<{ run: () => void; due: number; cleared?: boolean }> = [], leases: any[] = [], refreshed: any[] = [], incoming: any[] = [], statuses: any[] = []
  let stops = 0
  const watcher = createActiveWalletWatch({ getScope: () => scope, canWatch: () => ready, isChainEnabled: () => true,
    start: (addresses, onEvent, onStatus) => leases.push({ addresses, onEvent, onStatus }), stop: () => { stops++ },
    refresh: async (hint, isCurrent) => { refreshed.push(hint); await refresh?.(hint, isCurrent) },
    onIncoming: (_watch, data) => incoming.push(data), onStatus: value => statuses.push(value), now: () => clock,
    setTimer: (run, ms) => { const timer = { run, due: clock + ms }; timers.push(timer); return timer }, clearTimer: timer => { (timer as any).cleared = true }, ...extra })
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  async function tick() {
    const timer = timers.filter(timer => !timer.cleared).sort((a, b) => a.due - b.due)[0]
    if (!timer) return false
    timer.cleared = true; clock = Math.max(clock, timer.due); timer.run(); await flush(); return true
  }
  return { watcher, tick, flush, leases, refreshed, incoming, statuses, get stops() { return stops }, get clock() { return clock }, setReady: (value: boolean) => { ready = value },
    nextWallet: () => { scope = { epoch: scope.epoch + 1, deviceId: 'device', walletId: 'wallet-B', wallet: {} } } }
}
const emit = (lease: any, type: string, data: any) => lease.onEvent({ type, data })

test('all four Litecoin account scripts register together; identical inventory does not restart or resync', async () => {
  const h = harness(); h.watcher.add(watches); await h.tick()
  expect(h.leases[0].addresses).toHaveLength(8)
  emit(h.leases[0], 'connected', { watching: 8 })
  emit(h.leases[0], 'sync:required', { reason: 'subscribe', refreshHint: true })
  await h.tick(); expect(h.refreshed).toEqual([{ chainId: 'litecoin', txids: [], catchup: true }])
  h.watcher.add(watches); await h.tick()
  expect(h.leases).toHaveLength(1); expect(h.refreshed).toHaveLength(1)
})

test('bootstrap inventory batches into one complete lease', async () => {
  const h = harness(); h.watcher.add([]); const finish = h.watcher.beginBatch()
  for (const watch of watches) h.watcher.add([watch])
  expect(await h.tick()).toBe(false)
  finish(); await h.tick(); expect(h.leases).toHaveLength(1); expect(h.leases[0].addresses).toHaveLength(8)
})
test('an initially empty lease explicitly replaces old monitoring and lease persistence failure does not block the active stream', async () => {
  const empty: any[] = [], errors: unknown[] = [], timers: Array<() => void> = []; let starts = 0
  const scope = { epoch: 1, deviceId: 'fixture', walletId: 'fixture', wallet: {} }
  const watcher = createActiveWalletWatch({ getScope: () => scope, canWatch: () => true, isChainEnabled: () => true,
    start: () => { starts++ }, stop: () => {}, refresh: async () => {}, onLease: addresses => { empty.push(addresses); if (addresses.length) throw new Error('disk failed') }, onError: error => errors.push(error),
    setTimer: run => { timers.push(run); return run }, clearTimer: () => {} })
  watcher.add([]); const finish = watcher.beginBatch(); timers.length = 0; finish(); timers.shift()!()
  expect(empty).toEqual([[]]); expect(starts).toBe(0)
  watcher.add(watches); timers.shift()!(); expect(starts).toBe(1); expect(errors).toHaveLength(1); watcher.stop()
})

test('expanded xpub leaf hints refresh directly, dedupe transitions and reject foreign members', async () => {
  const h = harness(); h.watcher.add(watches); await h.tick(); await h.tick(); h.refreshed.length = 0
  const data = { watchedAddress: watches[0].address, address: 'unknown-gap-leaf', networkId: ltc.networkId, txid: 'payment', type: 'incoming' }
  emit(h.leases[0], 'tx:incoming', data); emit(h.leases[0], 'tx:incoming', data)
  emit(h.leases[0], 'tx:incoming', { ...data, watchedAddress: 'foreign-xpub' })
  emit(h.leases[0], 'tx:incoming', { ...data, networkId: 'wrong-network' })
  await h.tick()
  expect(h.refreshed).toEqual([{ chainId: 'litecoin', txids: ['payment'], catchup: false }]); expect(h.incoming).toHaveLength(1)
  emit(h.leases[0], 'tx:confirmed', data); await h.tick(); expect(h.refreshed).toHaveLength(2)
})

test('activity hints without a hash invalidate data without inventing a payment receipt', async () => {
  const h = harness(); h.watcher.add(watches); await h.tick(); await h.tick(); h.refreshed.length = 0
  emit(h.leases[0], 'tx:incoming', { address: watches[0].address, networkId: ltc.networkId, refreshHint: true, type: 'activity' })
  await h.tick(); expect(h.refreshed).toEqual([{ chainId: 'litecoin', txids: [], catchup: false }]); expect(h.incoming).toEqual([])
})

test('stop and wallet changes reject queued old callbacks and leave no idle work', async () => {
  const h = harness(); h.watcher.add(watches); await h.tick(); const old = h.leases[0]
  h.watcher.stop(); h.nextWallet()
  emit(old, 'tx:incoming', { address: watches[0].address, networkId: ltc.networkId, type: 'incoming', txid: 'old' })
  old.onStatus({ connected: true, watching: 8 })
  expect(await h.tick()).toBe(false); expect(h.refreshed).toEqual([])
  expect(h.statuses.at(-1)).toEqual({ connected: false, watching: 0 })
})

test('catchup limits parallel chain reads and an in-flight old-wallet result cannot publish', async () => {
  const finish: Array<() => void> = [], published: string[] = []
  const h = harness(async (hint, isCurrent) => { await new Promise<void>(resolve => finish.push(resolve)); if (isCurrent()) published.push(hint.chainId) })
  h.watcher.add(['a', 'b', 'c'].map(chain => ({ ...watches[0], chainId: chain, networkId: chain })))
  await h.tick(); await h.tick(); expect(h.refreshed).toHaveLength(2)
  finish[0](); await h.flush(); expect(h.refreshed).toHaveLength(3)
  h.watcher.stop(); h.nextWallet(); finish[1](); finish[2](); await h.flush()
  expect(published).toEqual(['a']); expect(await h.tick()).toBe(false)
})

test('a reconnect requests one catchup without replacing a stable lease', async () => {
  const h = harness(); h.watcher.add(watches); await h.tick(); await h.tick()
  emit(h.leases[0], 'connected', {}); emit(h.leases[0], 'connected', {})
  // Move beyond the initial handshake coalescing window before a later reconnect.
  h.watcher.add(watches); for (let i = 0; i < 10; i++) { h.watcher.add(watches); await h.tick() }
  emit(h.leases[0], 'connected', {}); emit(h.leases[0], 'sync:required', { reason: 'upstream_reconnected' })
  await h.tick(); expect(h.leases).toHaveLength(1); expect(h.refreshed).toHaveLength(2)
})

test('account coverage takes priority over receive leaf churn and base58 identity remains case-sensitive', () => {
  const leaves = Array.from({ length: 30 }, (_, i) => ({ ...watches[0], address: `leaf-${i}`, account: false }))
  const selected = selectOwnedWatches([...watches, ...leaves])
  expect(selected.filter(watch => watch.account)).toHaveLength(8); expect(selected).toHaveLength(16)
  expect(ownedWatchKey({ networkId: 'solana:mainnet', address: 'AbCd' })).not.toBe(ownedWatchKey({ networkId: 'solana:mainnet', address: 'abcd' }))
  expect(ownedWatchKey({ networkId: 'eip155:1', address: '0xAbCd' })).toBe(ownedWatchKey({ networkId: 'eip155:1', address: '0xabcd' }))
})
test('receipt notification requires a matching freshly verified native history row', async () => {
  const received: string[] = [], reads: any[] = [], retries: string[] = []
  const deps: any = { readBalance: async (params: any) => { reads.push(params); return { syncState: 'confirmed' } }, follow: () => {}, retry: (chain: string) => retries.push(chain),
    onReceive: (_chain: string, txid: string) => received.push(txid), scanHistory: async () => ({ rows: [
      { chainId: 'litecoin', txid: 'native', type: 'receive', nativeReceiveVerified: true },
      { chainId: 'litecoin', txid: 'self', type: 'receive', nativeReceiveVerified: false },
      { chainId: 'litecoin', txid: 'token', type: 'receive' }, { chainId: 'litecoin', txid: 'outgoing', type: 'send', nativeReceiveVerified: true },
      { chainId: 'ethereum', txid: 'other-chain', type: 'receive', nativeReceiveVerified: true },
    ] }) }
  await refreshWatchedChain({ chainId: 'litecoin', txids: ['native', 'self', 'token', 'outgoing', 'other-chain'], catchup: false }, deps, () => true)
  expect(reads).toEqual([{ chainId: 'litecoin', forceRefresh: true }]); expect(received).toEqual(['native']); expect(retries).toEqual(['litecoin'])
})
test('stale, degraded, cancelled and failed history reads reject processing before acknowledgement', async () => {
  let scans = 0
  const deps: any = { readBalance: async () => ({ syncState: 'stale' }), scanHistory: async () => { scans++; return { rows: [] } }, follow: () => {}, retry: () => {}, onReceive: () => {} }
  for (const syncState of ['stale', 'degraded', undefined]) {
    deps.readBalance = async () => ({ syncState })
    await expect(refreshWatchedChain({ chainId: 'litecoin', txids: [], catchup: true }, deps, () => true)).rejects.toThrow('freshly verified')
  }
  expect(scans).toBe(0)
  deps.readBalance = async () => ({ syncState: 'confirmed' }); deps.scanHistory = async () => ({ rows: [], error: 'partial history' })
  await expect(refreshWatchedChain({ chainId: 'litecoin', txids: [], catchup: true }, deps, () => true)).rejects.toThrow('history')
  await expect(refreshWatchedChain({ chainId: 'litecoin', txids: [], catchup: true }, deps, () => false)).rejects.toThrow('cancelled')
})
test('unproven native and token activity refreshes without claiming an incoming payment', async () => {
  const incoming: string[] = [], activity: string[] = []
  await refreshWatchedChain({ chainId: 'litecoin', txids: ['ambiguous'], catchup: false }, {
    readBalance: async () => ({ syncState: 'confirmed' } as any), scanHistory: async () => ({ rows: [{ chainId: 'litecoin', txid: 'ambiguous', type: 'receive', nativeReceiveVerified: false } as any] }),
    follow: () => {}, retry: () => {}, onReceive: (_chain, txid) => incoming.push(txid), onActivity: (chain) => activity.push(chain),
  }, () => true)
  expect(incoming).toEqual([]); expect(activity).toEqual(['litecoin'])
})
test('foreign replay hints are refused; a failing chain waits for its own retry without blocking a healthy one, and disabling it cancels the retry', async () => {
  let disabled = false
  const timers: Array<{ run: () => void; ms: number; cleared?: boolean }> = [], calls: string[] = []
  const scope = { epoch: 1, deviceId: 'fixture', walletId: 'fixture', wallet: {} }
  const next = (ms: number) => { const timer = timers.find(entry => !entry.cleared && entry.ms === ms)!; timer.cleared = true; timer.run() }
  const watcher = createActiveWalletWatch({ getScope: () => scope, canWatch: () => true, isChainEnabled: chain => chain !== 'bad' || !disabled,
    start: () => {}, stop: () => {}, backoff: createChainBackoff({ jitter: 0 }),
    setTimer: (run, ms) => { const timer = { run, ms }; timers.push(timer); return timer }, clearTimer: timer => { (timer as any).cleared = true },
    refresh: async hint => { calls.push(hint.chainId); if (hint.chainId === 'bad') throw new Error('upstream') } })
  watcher.add([{ ...watches[0], chainId: 'bad', networkId: 'bad' }, { ...watches[0], chainId: 'good', networkId: 'good' }])
  next(250); next(150); for (let i = 0; i < 10; i++) await Promise.resolve()
  expect([...calls].sort()).toEqual(['bad', 'good'])
  // KEEPKEY-109: the failed chain owns a scheduled retry, so it no longer holds back the batch (or the durable replay).
  expect(await watcher.flush()).toBe(true)
  const retry = timers.find(entry => entry.ms === 5_000)!
  expect(retry.cleared).toBeUndefined()
  expect(watcher.event({ type: 'tx:incoming', data: { watchedAddress: 'foreign', networkId: 'good' } } as any)).toBe(false)
  disabled = true; watcher.add([]); next(250)
  expect(retry.cleared).toBe(true)
  expect(await watcher.flush()).toBe(true); expect(calls).toHaveLength(2); watcher.stop()
})

describe('KEEPKEY-109: one chain failing (e.g. TRON history 429) backs off alone and never stalls the others', () => {
  const twoChains = ['a', 'b'].map(chain => ({ ...watches[0], chainId: chain, networkId: chain }))
  const steady = () => createChainBackoff({ jitter: 0 })
  const incomingOn = (chain: string, txid: string, eventId?: string) => ({ address: watches[0].address, networkId: chain, txid, type: 'incoming', ...(eventId ? { eventId } : {}) })

  test('the failing chain retries on its own after 5 s, then 15 s; the other chain is untouched; a success resets it', async () => {
    let failures = 2
    const retries: Array<[string, number, number]> = []
    const h = harness(async hint => { if (hint.chainId === 'a' && failures-- > 0) throw new Error('TRON history failed (429)') },
      { backoff: steady(), onRetryScheduled: (chain, delay, count) => retries.push([chain, delay, count]) })
    h.watcher.add(twoChains); await h.tick()
    // Waiting for the batch while it runs: it completes once b is done and a has its retry scheduled.
    const batch = h.watcher.flush()
    await h.tick()
    expect(h.refreshed.map(hint => hint.chainId).sort()).toEqual(['a', 'b'])
    expect(await batch).toBe(true)
    expect(retries).toEqual([['a', 5_000, 1]])
    const failedAt = h.clock
    await h.tick()
    expect(h.clock - failedAt).toBe(5_000)
    expect(h.refreshed.slice(2).map(hint => hint.chainId)).toEqual(['a'])
    expect(retries.at(-1)).toEqual(['a', 15_000, 2])
    await h.tick()
    expect(h.refreshed.slice(3).map(hint => hint.chainId)).toEqual(['a'])
    expect(retries).toHaveLength(2)
    expect(await h.tick()).toBe(false)
    // The success reset it: a later failure starts again from 5 s.
    failures = 1
    emit(h.leases[0], 'tx:incoming', incomingOn('a', 'later'))
    await h.tick()
    expect(retries.at(-1)).toEqual(['a', 5_000, 1])
    h.watcher.stop()
  })

  test('events for a waiting chain join its scheduled retry instead of calling the provider again', async () => {
    let fail = true
    const h = harness(async hint => { if (hint.chainId === 'a' && fail) throw new Error('429') }, { backoff: steady() })
    h.watcher.add(twoChains); await h.tick(); await h.tick(); h.refreshed.length = 0
    for (const txid of ['t1', 't2', 't3']) emit(h.leases[0], 'tx:incoming', incomingOn('a', txid))
    emit(h.leases[0], 'tx:incoming', incomingOn('b', 'b1'))
    await h.tick()
    expect(h.refreshed).toEqual([{ chainId: 'b', txids: ['b1'], catchup: false }])
    fail = false; await h.tick()
    expect(h.refreshed).toEqual([{ chainId: 'b', txids: ['b1'], catchup: false }, { chainId: 'a', txids: ['t1', 't2', 't3'], catchup: false }])
    h.watcher.stop()
  })

  test('a hint queued while the chain was running waits for the retry instead of re-running at once', async () => {
    let release!: () => void, first = true
    const h = harness(async hint => {
      if (hint.chainId !== 'a' || !first) return
      first = false; await new Promise<void>(resolve => { release = resolve }); throw new Error('429')
    }, { backoff: steady() })
    h.watcher.add(twoChains); await h.tick(); await h.tick(); h.refreshed.length = 0
    emit(h.leases[0], 'tx:incoming', incomingOn('a', 'during'))
    await h.tick()
    expect(h.refreshed).toEqual([])
    release(); await h.flush()
    expect(h.refreshed).toEqual([])
    await h.tick()
    expect(h.refreshed).toEqual([{ chainId: 'a', txids: ['during'], catchup: false }])
    h.watcher.stop()
  })

  test('a scheduled retry is cancelled on stop and never runs for the next wallet', async () => {
    const h = harness(async hint => { if (hint.chainId === 'a') throw new Error('429') }, { backoff: steady() })
    h.watcher.add(twoChains); await h.tick(); await h.tick(); h.refreshed.length = 0
    h.watcher.stop(); h.nextWallet()
    expect(await h.tick()).toBe(false)
    expect(h.refreshed).toEqual([])
  })

  test('a retry that comes due while the device is locked keeps its hint and runs once the wallet is unlocked', async () => {
    let fail = true
    const h = harness(async hint => { if (hint.chainId === 'a' && fail) throw new Error('429') }, { backoff: steady() })
    h.watcher.add(twoChains); await h.tick(); await h.tick()
    emit(h.leases[0], 'tx:incoming', incomingOn('a', 'paid-while-waiting', 'evt-1'))
    h.refreshed.length = 0
    h.setReady(false); await h.tick()
    expect(h.refreshed).toEqual([])
    fail = false; h.setReady(true); h.watcher.resume(); await h.tick(); await h.tick()
    // The unlock catchup merges with the kept hint: the payment is still a targeted, non-catchup refresh.
    expect(h.refreshed.filter(hint => hint.chainId === 'a')).toEqual([{ chainId: 'a', txids: ['paid-while-waiting'], catchup: false, eventIds: ['evt-1'] }])
    h.watcher.stop()
  })

  test(`after ${MAX_AUTO_RETRIES} automatic retries a broken chain pauses; only new activity on it arms one retry after the longest delay`, async () => {
    const paused: Array<[string, number]> = [], delays: number[] = []
    const h = harness(async hint => { if (hint.chainId === 'a') throw new Error('history endpoint down') },
      { backoff: steady(), onRetryPaused: (chain, failures) => paused.push([chain, failures]), onRetryScheduled: (_chain, delay) => delays.push(delay) })
    h.watcher.add(twoChains); await h.tick(); await h.tick()
    for (let i = 0; i < MAX_AUTO_RETRIES; i++) await h.tick()
    expect(delays).toEqual([5_000, 15_000, 30_000, 60_000, 120_000])
    expect(h.refreshed.filter(hint => hint.chainId === 'a')).toHaveLength(1 + MAX_AUTO_RETRIES)
    expect(paused).toEqual([['a', MAX_AUTO_RETRIES + 1]])
    // Paused: no timer, so nothing polls the broken provider, and the batch is still complete.
    expect(await h.tick()).toBe(false)
    expect(await h.watcher.flush()).toBe(true)
    // Real activity arms exactly one retry, after the longest delay, and duplicates join it.
    const before = h.clock
    emit(h.leases[0], 'tx:incoming', incomingOn('a', 'new-payment'))
    emit(h.leases[0], 'tx:incoming', incomingOn('a', 'another'))
    expect(delays.at(-1)).toBe(120_000)
    await h.tick()
    expect(h.clock - before).toBe(120_000)
    expect(h.refreshed.filter(hint => hint.chainId === 'a')).toHaveLength(2 + MAX_AUTO_RETRIES)
    expect(h.refreshed.at(-1)!.txids).toEqual(['new-payment', 'another'])
    expect(paused.at(-1)).toEqual(['a', MAX_AUTO_RETRIES + 2])
    expect(await h.tick()).toBe(false)
    h.watcher.stop()
  })

  test('a retry that comes due while two other chains are refreshing waits for a free slot', async () => {
    const finish: Array<() => void> = []
    let first = true
    const h = harness(async hint => {
      if (hint.chainId === 'a' && first) { first = false; throw new Error('429') }
      if (hint.chainId !== 'a') await new Promise<void>(resolve => finish.push(resolve))
    }, { backoff: steady() })
    h.watcher.add(['a', 'b', 'c'].map(chain => ({ ...watches[0], chainId: chain, networkId: chain })))
    await h.tick(); await h.tick()
    // a failed at once; b is running and c took the second slot right after.
    expect(h.refreshed.map(hint => hint.chainId)).toEqual(['a', 'b', 'c'])
    await h.tick()
    expect(h.refreshed).toHaveLength(3)
    finish.shift()!(); await h.flush()
    expect(h.refreshed.map(hint => hint.chainId)).toEqual(['a', 'b', 'c', 'a'])
    finish.shift()!(); await h.flush(); h.watcher.stop()
  })

  test('disabling a waiting chain cancels its retry and its count; enabling it again starts fresh', async () => {
    let enabled = true, fail = true
    const delays: number[] = []
    const h = harness(async hint => { if (hint.chainId === 'a' && fail) throw new Error('429') },
      { backoff: steady(), isChainEnabled: chain => chain !== 'a' || enabled, onRetryScheduled: (_chain, delay) => delays.push(delay) })
    h.watcher.add(twoChains); await h.tick(); await h.tick()
    expect(delays).toEqual([5_000])
    enabled = false; h.watcher.add(twoChains); await h.tick()
    expect(await h.tick()).toBe(false)
    enabled = true; h.watcher.add(twoChains); await h.tick(); await h.tick()
    expect(delays).toEqual([5_000, 5_000])
    fail = false; await h.tick()
    expect(h.refreshed.at(-1)!.chainId).toBe('a')
    expect(await h.tick()).toBe(false)
    h.watcher.stop()
  })

  test('a transaction seen again while waiting counts as the most recent one', async () => {
    let fail = true
    const h = harness(async hint => { if (hint.chainId === 'a' && fail) throw new Error('429') }, { backoff: steady() })
    h.watcher.add(twoChains); await h.tick(); await h.tick(); h.refreshed.length = 0
    for (const txid of ['t1', 't2', 't1']) emit(h.leases[0], 'tx:incoming', incomingOn('a', txid))
    fail = false; await h.tick()
    expect(h.refreshed.at(-1)!.txids).toEqual(['t2', 't1'])
    h.watcher.stop()
  })

  test('a chain disabled while its failing refresh runs schedules no retry', async () => {
    let enabled = true, release!: () => void
    const scheduled: string[] = []
    const h = harness(async hint => {
      if (hint.chainId !== 'a') return
      await new Promise<void>(resolve => { release = resolve }); throw new Error('429')
    }, { backoff: steady(), isChainEnabled: chain => chain !== 'a' || enabled, onRetryScheduled: chain => scheduled.push(chain) })
    h.watcher.add(twoChains); await h.tick(); await h.tick()
    enabled = false; release(); await h.flush()
    expect(scheduled).toEqual([])
    expect(await h.tick()).toBe(false)
    h.watcher.stop()
  })

  test('a long outage keeps only the most recent hints for the retry', async () => {
    let fail = true
    const h = harness(async hint => { if (hint.chainId === 'a' && fail) throw new Error('429') }, { backoff: steady() })
    h.watcher.add(twoChains); await h.tick(); await h.tick(); h.refreshed.length = 0
    for (let i = 0; i < 300; i++) emit(h.leases[0], 'tx:incoming', incomingOn('a', `t${i}`, `e${i}`))
    fail = false; await h.tick()
    const retried = h.refreshed.at(-1)
    expect(h.refreshed).toHaveLength(1)
    expect(retried.txids).toEqual(Array.from({ length: 32 }, (_, i) => `t${268 + i}`))
    expect(retried.eventIds).toEqual(Array.from({ length: 256 }, (_, i) => `e${44 + i}`))
    h.watcher.stop()
  })
})

const cacheNow = 2 * BALANCE_CACHE_QUIET_WINDOW_MS
const cachedRow = (patch: Partial<ChainBalance> = {}): ChainBalance => ({
  chainId: 'litecoin', symbol: 'LTC', address: '', balance: '1', balanceUsd: 10,
  updatedAt: cacheNow - 60_000, ...patch,
})
const activityRow = (patch: Partial<RecentActivity> = {}): RecentActivity => ({
  id: 'fixture-activity', chainId: 'litecoin', chain: 'LTC', txid: 'fixture-transaction',
  type: 'send', source: 'scan', status: 'completed', createdAt: cacheNow - 120_000, ...patch,
})
function cacheReadHarness(cached: ChainBalance | undefined, rows: RecentActivity[] = []) {
  const reads: unknown[] = [], order: string[] = [], follows: string[] = [], retries: string[] = [], notices: string[] = []
  const deps = {
    now: () => cacheNow,
    readCachedBalance: (_chainId: string) => cached,
    readBalance: async (params: { chainId: string; forceRefresh: true }) => {
      reads.push(params); order.push('balance'); return cachedRow({ syncState: 'confirmed', updatedAt: cacheNow })
    },
    scanHistory: async (_chainId: string, _isCurrent: () => boolean) => { order.push('history'); return { rows } },
    follow: (_chainId: string, txid: string) => { follows.push(txid) },
    retry: (_chainId: string, txid?: string) => { retries.push(txid ?? '') },
    onReceive: () => { notices.push('receive') },
    onActivity: () => { notices.push('activity') },
  }
  return { deps, reads, order, follows, retries, notices }
}
const catchup = { chainId: 'litecoin', txids: [], catchup: true }

test('reopen catchup retains a recent legacy or zero balance while still catching up history', async () => {
  for (const balance of ['1', '0']) {
    const h = cacheReadHarness(cachedRow({ balance }), [activityRow()])
    await refreshWatchedChain(catchup, h.deps, () => true)
    expect(h.order).toEqual(['history']); expect(h.reads).toHaveLength(0)
    expect(h.follows).toEqual([]); expect(h.retries).toEqual([]); expect(h.notices).toEqual([])
  }
})

test('unknown, expired, invalidated, degraded or foreign-chain cache never skips the balance read', async () => {
  for (const cached of [undefined, cachedRow({ updatedAt: undefined }),
    cachedRow({ updatedAt: cacheNow - BALANCE_CACHE_QUIET_WINDOW_MS }), cachedRow({ syncState: 'stale' }),
    cachedRow({ syncState: 'degraded' }), cachedRow({ txPending: true }), cachedRow({ balance: 'NaN' }),
    cachedRow({ chainId: 'bitcoin' })]) {
    const h = cacheReadHarness(cached)
    await refreshWatchedChain(catchup, h.deps, () => true)
    expect(h.order).toEqual(['balance', 'history'])
    expect(h.reads).toEqual([{ chainId: 'litecoin', forceRefresh: true }])
  }
})

test('incoming and confirmed hints refresh even a recent cache and keep their targeted retries', async () => {
  for (const txid of ['incoming-transaction', 'confirmed-transaction']) {
    const h = cacheReadHarness(cachedRow())
    await refreshWatchedChain({ ...catchup, txids: [txid], catchup: false }, h.deps, () => true)
    expect(h.order).toEqual(['balance', 'history'])
    expect(h.reads).toEqual([{ chainId: 'litecoin', forceRefresh: true }])
    expect(h.follows).toEqual([txid]); expect(h.retries).toEqual([txid]); expect(h.notices).toEqual(['activity'])
  }
})

test('a real hint coalesced with startup catchup still performs its targeted balance read', async () => {
  const read = cacheReadHarness(cachedRow())
  const h = harness((hint, isCurrent) => refreshWatchedChain(hint, read.deps, isCurrent))
  h.watcher.add(watches); await h.tick()
  emit(h.leases[0], 'tx:incoming', { address: watches[0].address, networkId: ltc.networkId, txid: 'new-payment', type: 'incoming' })
  await h.tick()
  expect(h.refreshed[0].catchup).toBe(false)
  expect(read.reads).toEqual([{ chainId: 'litecoin', forceRefresh: true }])
  expect(read.retries).toEqual(['new-payment'])
  h.watcher.stop()
})

test('chain activity newer than the cached snapshot refreshes once after history, including failed-fee transactions', async () => {
  for (const status of ['broadcast', 'completed', 'refunded', 'failed'] as const) {
    const row = activityRow({ status, createdAt: cacheNow - 1 })
    const h = cacheReadHarness(cachedRow(), [row, row])
    await refreshWatchedChain(catchup, h.deps, () => true)
    expect(h.order).toEqual(['history', 'balance'])
    expect(h.reads).toEqual([{ chainId: 'litecoin', forceRefresh: true }])
    expect(h.notices).toEqual(['activity'])
    expect(h.follows).toEqual(status === 'broadcast' ? [row.txid!] : [])
    expect(h.retries).toEqual(status === 'broadcast' ? [row.txid!] : [])
  }
})

test('old, foreign, sign-only and unidentified history rows cannot invalidate a quiet cache', async () => {
  const h = cacheReadHarness(cachedRow(), [activityRow(), activityRow({ createdAt: cacheNow - 60_000 }),
    activityRow({ createdAt: cacheNow, chainId: 'bitcoin' }), activityRow({ createdAt: cacheNow, txid: undefined }),
    activityRow({ createdAt: NaN }), activityRow({ createdAt: cacheNow, status: 'signed' }),
    activityRow({ createdAt: cacheNow, status: 'not_sent' })])
  await refreshWatchedChain(catchup, h.deps, () => true)
  expect(h.order).toEqual(['history']); expect(h.reads).toEqual([]); expect(h.notices).toEqual([])
})

test('quiet catchup still rejects failed history and retired wallet scope', async () => {
  const h = cacheReadHarness(cachedRow())
  await expect(refreshWatchedChain(catchup, { ...h.deps, scanHistory: async () => ({ rows: [], error: 'history unavailable' }) }, () => true))
    .rejects.toThrow('history')
  let current = true
  await expect(refreshWatchedChain(catchup, { ...h.deps, readCachedBalance: () => { current = false; return cachedRow() } }, () => current))
    .rejects.toThrow('cancelled')
  expect(h.order).toEqual([]); expect(h.reads).toEqual([])
  expect(h.retries).toEqual([])
})

test('an unavailable cache falls back to the ordinary catchup read instead of hiding history', async () => {
  const h = cacheReadHarness(cachedRow())
  await refreshWatchedChain(catchup, { ...h.deps, readCachedBalance: () => { throw new Error('cache unavailable') } }, () => true)
  expect(h.order).toEqual(['balance', 'history']); expect(h.retries).toEqual([])
})

test('a stored transaction mark retains one scoped catchup retry when its first balance read fails', async () => {
  for (const failure of ['throw', 'stale'] as const) {
    const h = cacheReadHarness(cachedRow({ txPending: true, syncState: 'stale' }))
    await expect(refreshWatchedChain(catchup, { ...h.deps, readBalance: async () => {
      if (failure === 'throw') throw new Error('upstream unavailable')
      return cachedRow({ syncState: 'stale' })
    } }, () => true)).rejects.toThrow()
    expect(h.retries).toEqual(['']); expect(h.order).toEqual([]); expect(h.notices).toEqual([])
  }
  const expired = cacheReadHarness(cachedRow({ updatedAt: cacheNow - BALANCE_CACHE_QUIET_WINDOW_MS }))
  await expect(refreshWatchedChain(catchup, { ...expired.deps, readBalance: async () => { throw new Error('upstream unavailable') } }, () => true))
    .rejects.toThrow('upstream unavailable')
  expect(expired.retries).toEqual([])
  let current = true
  const retired = cacheReadHarness(cachedRow({ txPending: true, syncState: 'stale' }))
  await expect(refreshWatchedChain(catchup, { ...retired.deps, readBalance: async () => { current = false; throw new Error('retired') } }, () => current))
    .rejects.toThrow('retired')
  expect(retired.retries).toEqual([])
})

test('newer history cannot be acknowledged when its required balance read is unverified', async () => {
  const h = cacheReadHarness(cachedRow(), [activityRow({ createdAt: cacheNow })])
  await expect(refreshWatchedChain(catchup, { ...h.deps, readBalance: async () => cachedRow({ syncState: 'stale' }) }, () => true))
    .rejects.toThrow('freshly verified')
  expect(h.notices).toEqual([]); expect(h.retries).toEqual(['fixture-transaction'])
})

test('newer pending history follows confirmation before a failed balance read and keeps its retry', async () => {
  for (const status of ['broadcast', 'completed', 'failed'] as const) {
    const h = cacheReadHarness(cachedRow(), [activityRow({ status, createdAt: cacheNow })])
    await expect(refreshWatchedChain(catchup, { ...h.deps, readBalance: async () => {
      expect(h.follows).toEqual(status === 'broadcast' ? ['fixture-transaction'] : [])
      throw new Error('balance unavailable')
    } }, () => true)).rejects.toThrow('balance unavailable')
    expect(h.retries).toEqual(['fixture-transaction']); expect(h.notices).toEqual([])
  }
})

test('live hints retain retries after balance or history failure, without claiming receipts', async () => {
  const hint = { ...catchup, catchup: false, txids: ['live-payment'] }
  for (const stage of ['balance', 'history'] as const) {
    const h = cacheReadHarness(cachedRow())
    const deps = stage === 'balance'
      ? { ...h.deps, readBalance: async () => { throw new Error('upstream failure') } }
      : { ...h.deps, scanHistory: async () => { throw new Error('upstream failure') } }
    await expect(refreshWatchedChain(hint, deps, () => true)).rejects.toThrow('upstream failure')
    expect(h.follows).toEqual(['live-payment']); expect(h.retries).toEqual(['live-payment'])
    expect(h.notices).toEqual([])
  }
})

test('a wallet retired during an activity balance read cannot arm retries for its successor', async () => {
  for (const catchupOnly of [true, false]) {
    let current = true
    const h = cacheReadHarness(cachedRow(), [activityRow({ status: 'broadcast', createdAt: cacheNow })])
    await expect(refreshWatchedChain({ ...catchup, catchup: catchupOnly, txids: catchupOnly ? [] : ['live-payment'] }, {
      ...h.deps, readBalance: async () => { current = false; throw new Error('retired') },
    }, () => current)).rejects.toThrow('retired')
    expect(h.retries).toEqual([]); expect(h.notices).toEqual([])
  }
})

test('a new transaction arriving while quiet catchup history is in flight is drained afterward', async () => {
  let release!: () => void, first = true
  const read = cacheReadHarness(cachedRow())
  const deps = { ...read.deps, scanHistory: async (...args: Parameters<typeof read.deps.scanHistory>) => {
    if (first) { first = false; await new Promise<void>(resolve => { release = resolve }) }
    return read.deps.scanHistory(...args)
  } }
  const h = harness((hint, isCurrent) => refreshWatchedChain(hint, deps, isCurrent))
  h.watcher.add(watches); await h.tick(); await h.tick()
  expect(read.reads).toEqual([])
  emit(h.leases[0], 'tx:incoming', { address: watches[0].address, networkId: ltc.networkId, txid: 'arrived-during-catchup', type: 'incoming' })
  await h.tick(); release(); expect(await h.watcher.flush()).toBe(true)
  expect(h.refreshed.map(hint => hint.catchup)).toEqual([true, false])
  expect(read.reads).toEqual([{ chainId: 'litecoin', forceRefresh: true }])
  expect(read.retries).toEqual(['arrived-during-catchup'])
  h.watcher.stop()
})
