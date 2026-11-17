import { expect, test } from 'bun:test'
import { createActiveWalletWatch, ownedWatchKey, refreshWatchedChain, selectOwnedWatches, type OwnedWatch } from '../src/bun/active-wallet-watch'
import type { BalanceRefreshScope } from '../src/bun/post-tx-balance'
import { utxoAccountScriptPaths } from '../src/bun/chain-scan'
import { CHAINS } from '../src/shared/chains'
import type { ChainBalance, RecentActivity } from '../src/shared/types'
import { BALANCE_CACHE_QUIET_WINDOW_MS } from '../src/shared/balance-cache-policy'
const ltc = CHAINS.find(chain => chain.id === 'litecoin')!
const watches = [0, 1].flatMap(account => utxoAccountScriptPaths(ltc, account).map(path => ({ address: `${path.scriptType}-${path.path[0]}-${account}`, networkId: ltc.networkId, chainId: ltc.id, caip: ltc.caip, account: true, path: path.path.join('/') })))
function harness(refresh?: (hint: any, isCurrent: () => boolean) => Promise<void>) {
  let clock = 0, ready = true
  let scope: BalanceRefreshScope = { epoch: 1, deviceId: 'device', walletId: 'wallet-A', wallet: {} }
  const timers: Array<{ run: () => void; due: number; cleared?: boolean }> = [], leases: any[] = [], refreshed: any[] = [], incoming: any[] = [], statuses: any[] = []
  let stops = 0
  const watcher = createActiveWalletWatch({ getScope: () => scope, canWatch: () => ready, isChainEnabled: () => true,
    start: (addresses, onEvent, onStatus) => leases.push({ addresses, onEvent, onStatus }), stop: () => { stops++ },
    refresh: async (hint, isCurrent) => { refreshed.push(hint); await refresh?.(hint, isCurrent) },
    onIncoming: (_watch, data) => incoming.push(data), onStatus: value => statuses.push(value), now: () => clock,
    setTimer: (run, ms) => { const timer = { run, due: clock + ms }; timers.push(timer); return timer }, clearTimer: timer => { (timer as any).cleared = true } })
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  async function tick() {
    const timer = timers.filter(timer => !timer.cleared).sort((a, b) => a.due - b.due)[0]
    if (!timer) return false
    timer.cleared = true; clock = Math.max(clock, timer.due); timer.run(); await flush(); return true
  }
  return { watcher, tick, flush, leases, refreshed, incoming, statuses, get stops() { return stops }, setReady: (value: boolean) => { ready = value },
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
test('foreign replay hints are not accepted and obsolete failed chains do not block a healthy new lease', async () => {
  let disabled = false, fail = true
  const leases: any[] = [], timers: Array<() => void> = []
  const scope = { epoch: 1, deviceId: 'fixture', walletId: 'fixture', wallet: {} }
  const watcher = createActiveWalletWatch({ getScope: () => scope, canWatch: () => true, isChainEnabled: chain => chain !== 'bad' || !disabled,
    start: (addresses, onEvent) => leases.push({ addresses, onEvent }), stop: () => {}, setTimer: run => { timers.push(run); return run }, clearTimer: () => {},
    refresh: async hint => { if (hint.chainId === 'bad' && fail) throw new Error('upstream') } })
  watcher.add([{ ...watches[0], chainId: 'bad', networkId: 'bad' }, { ...watches[0], chainId: 'good', networkId: 'good' }])
  timers.shift()!(); timers.shift()!(); for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(await watcher.flush()).toBe(false)
  expect(watcher.event({ type: 'tx:incoming', data: { watchedAddress: 'foreign', networkId: 'good' } } as any)).toBe(false)
  disabled = true; fail = false; watcher.add([]); timers.shift()!()
  expect(await watcher.flush()).toBe(true); watcher.stop()
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
