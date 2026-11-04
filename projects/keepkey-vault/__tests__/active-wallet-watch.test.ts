import { expect, test } from 'bun:test'
import { createActiveWalletWatch, ownedWatchKey, refreshWatchedChain, selectOwnedWatches, type OwnedWatch } from '../src/bun/active-wallet-watch'
import type { BalanceRefreshScope } from '../src/bun/post-tx-balance'
import { utxoAccountScriptPaths } from '../src/bun/chain-scan'
import { CHAINS } from '../src/shared/chains'
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
