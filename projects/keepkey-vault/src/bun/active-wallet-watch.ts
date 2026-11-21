import type { AddressEntry, StreamEvent } from './event-stream'
import { sameBalanceRefreshScope, type BalanceRefreshScope } from './post-tx-balance'
import type { ChainBalance, RecentActivity } from '../shared/types'
import { usableCachedBalance } from '../shared/balance-cache-policy'
import { CHAIN_RETRY_DELAYS_MS, createChainBackoff, type ChainBackoff } from './chain-backoff'

export interface OwnedWatch extends AddressEntry {
  chainId: string
  caip: string
  account?: boolean
  path?: string
  scriptType?: string
}
type Hint = { chainId: string; txids: string[]; catchup: boolean; eventIds?: string[] }
/** Bounds what one chain accumulates while it waits (a burst of events during a long provider outage). The most recently
 *  seen entries are kept: older transactions are still found by the next history scan. An event id left out is only not
 *  acknowledged on its own: a live event can still be replayed, and a replayed one was acknowledged with its page. */
const MAX_HINT_TXIDS = 32, MAX_HINT_EVENT_IDS = 256
/** Unique values, the most recently seen last (a repeated value moves to the end), keeping at most `max`. */
const latest = <T>(values: T[], max: number) => {
  const recent = new Set<T>()
  for (const value of values) { recent.delete(value); recent.add(value) }
  return [...recent].slice(-max)
}
/** After this many consecutive failures a chain stops retrying by itself (KEEPKEY-109): a provider broken for hours is
 *  not polled forever. Its hints wait for real activity on it, which arms one retry after the longest delay. */
export const MAX_AUTO_RETRIES = 5
function mergeHint(previous: Hint | undefined, next: Hint): Hint {
  const eventIds = latest([...(previous?.eventIds || []), ...(next.eventIds || [])], MAX_HINT_EVENT_IDS)
  return { chainId: next.chainId, txids: latest([...(previous?.txids || []), ...next.txids], MAX_HINT_TXIDS),
    catchup: previous ? previous.catchup && next.catchup : next.catchup, ...(eventIds.length ? { eventIds } : {}) }
}
/** Transaction hints require both reads. Ordinary catchup can reuse a recent
 * balance snapshot while continuing to check history. */
export async function refreshWatchedChain(hint: Hint, deps: {
  readBalance: (params: { chainId: string; forceRefresh: true }, isCurrent: () => boolean) => Promise<ChainBalance>
  readCachedBalance?: (chainId: string) => ChainBalance | undefined
  now?: () => number
  scanHistory: (chainId: string, isCurrent: () => boolean) => Promise<{ rows: RecentActivity[]; error?: unknown }>
  follow: (chainId: string, txid: string) => void
  retry: (chainId: string, txid?: string) => void
  onReceive: (chainId: string, txid: string) => void
  onActivity?: (chainId: string, txid?: string) => void
}, isCurrent: () => boolean): Promise<void> {
  const assertCurrent = () => { if (!isCurrent()) throw new Error('Wallet watch refresh cancelled') }
  assertCurrent()
  let retryRequired = !hint.catchup
  let retryTxid = hint.txids.at(-1)
  try {
    for (const txid of hint.txids) deps.follow(hint.chainId, txid)
    let cached: ChainBalance | undefined
    if (hint.catchup) {
      try { cached = deps.readCachedBalance?.(hint.chainId) } catch { /* An unavailable cache cannot authorize skipping the read. */ }
      // A persisted transaction mark survives restart even when its first
      // balance read fails before history can supply a transaction id.
      if (cached?.chainId === hint.chainId && cached.txPending) retryRequired = true
    }
    // Reopening or reconnecting does not invalidate a recent known amount. Still
    // catch history up; a real transaction hint always performs the balance read.
    const reuseCached = hint.catchup && cached?.chainId === hint.chainId
      && usableCachedBalance(cached, deps.now?.() ?? Date.now())
    if (!reuseCached) {
      const balance = await deps.readBalance({ chainId: hint.chainId, forceRefresh: true }, isCurrent)
      assertCurrent()
      if (balance.syncState !== 'confirmed') throw new Error('Wallet watch balance could not be freshly verified')
    }
    assertCurrent()
    const history = await deps.scanHistory(hint.chainId, isCurrent)
    assertCurrent()
    if (history.error || !Array.isArray(history.rows)) throw new Error('Wallet watch history could not be freshly verified')
    // History can reveal a payment missed while the app was closed. That is an
    // actual chain change, unlike a reconnect, and retires the quiet cached read.
    const newerActivity = reuseCached ? history.rows.filter(row => row.chainId === hint.chainId && !!row.txid
      && Number.isFinite(row.createdAt) && row.createdAt > cached!.updatedAt!
      && ['broadcast', 'completed', 'refunded', 'failed'].includes(row.status)) : []
    if (newerActivity.length) {
      const pending = [...new Set(newerActivity.filter(row => row.status === 'broadcast').map(row => row.txid!))]
      retryTxid = pending.at(-1) ?? newerActivity.at(-1)!.txid
      retryRequired = true
      // Confirmation following and bounded retries must survive a failed first
      // balance read. A retired wallet must never schedule work in its successor.
      for (const txid of pending) deps.follow(hint.chainId, txid)
      const balance = await deps.readBalance({ chainId: hint.chainId, forceRefresh: true }, isCurrent)
      assertCurrent()
      if (balance.syncState !== 'confirmed') throw new Error('Wallet watch balance could not be freshly verified')
      retryRequired = pending.length > 0
      deps.onActivity?.(hint.chainId, newerActivity.at(-1)!.txid)
    }
    const key = (txid: string) => /^(?:0x)?[0-9a-f]{64}$/i.test(txid) ? txid.replace(/^0x/i, '').toLowerCase() : txid
    const hinted = new Set(hint.txids.map(key))
    let received = false
    for (const row of history.rows) if (row.txid && hinted.has(key(row.txid)) && row.chainId === hint.chainId
      && row.type === 'receive' && row.nativeReceiveVerified === true) { received = true; deps.onReceive(hint.chainId, row.txid) }
    if (!hint.catchup && !received) deps.onActivity?.(hint.chainId, hint.txids.at(-1))
  } finally {
    if (retryRequired && isCurrent()) deps.retry(hint.chainId, retryTxid)
  }
}
type Deps = {
  getScope: () => BalanceRefreshScope | null
  canWatch: () => boolean
  isChainEnabled: (chainId: string) => boolean
  start: (addresses: AddressEntry[], onEvent: (event: StreamEvent) => void, onStatus: (status: any) => void) => void
  stop: () => void
  refresh: (hint: Hint, isCurrent: () => boolean) => Promise<void>
  onIncoming?: (watch: OwnedWatch, data: any) => void
  onStatus?: (status: any) => void
  onError?: (error: unknown) => void
  onOverflow?: (omitted: number) => void
  onLease?: (addresses: AddressEntry[], scope: BalanceRefreshScope) => void
  onConnected?: () => void
  onProcessed?: (eventIds: string[], scope: BalanceRefreshScope) => Promise<void>
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  now?: () => number
  /** Per-chain retry delays after a failed refresh (KEEPKEY-109); defaults to createChainBackoff(). */
  backoff?: ChainBackoff
  /** `activity`: a paused chain got new activity, which armed this one retry. */
  onRetryScheduled?: (chainId: string, delayMs: number, failures: number, cause: 'failure' | 'activity') => void
  /** The chain failed more than MAX_AUTO_RETRIES times in a row and now retries only on new activity. */
  onRetryPaused?: (chainId: string, failures: number) => void
}
export function ownedWatchKey(watch: AddressEntry): string {
  return `${watch.networkId}:${watch.networkId.startsWith('eip155:') ? watch.address.toLowerCase() : watch.address}`
}

/** Xpubs cover whole account trees; recent leaf addresses supplement upstream
 * transports without displacing account coverage with receive-address churn. */
export function selectOwnedWatches(entries: OwnedWatch[], limit = 200): OwnedWatch[] {
  const accounts = entries.filter(entry => entry.account)
  const counts = new Map<string, number>()
  const leaves = entries.filter(entry => !entry.account).reverse().filter(entry => {
    const count = counts.get(entry.chainId) || 0
    counts.set(entry.chainId, count + 1)
    return count < 8
  })
  return [...accounts, ...leaves].slice(0, limit).sort((a, b) => ownedWatchKey(a).localeCompare(ownedWatchKey(b)))
}

/** One explicit connection lease for the active wallet. Transport hints never
 * establish an amount: they invalidate scoped balance/history reads. */
export function createActiveWalletWatch(deps: Deps) {
  const now = deps.now || Date.now
  const setTimer = deps.setTimer || ((run, ms) => setTimeout(run, ms))
  const clearTimer = deps.clearTimer || (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const owned = new Map<string, OwnedWatch>()
  const pending = new Map<string, Hint>()
  const running = new Map<string, object>()
  const seen = new Map<string, number>()
  const lastCatchup = new Map<string, number>()
  let scope: BalanceRefreshScope | null = null
  let generation = 0, leaseKey: string | undefined
  let batchDepth = 0, batchGeneration = 0
  const failedChains = new Set<string>()
  // A chain whose refresh failed waits on its own (KEEPKEY-109); the other chains keep refreshing. Per chain:
  // - waiting: a retry timer is armed and its hints collect in `deferred` until the timer moves them to `pending`;
  // - paused: it failed more than MAX_AUTO_RETRIES times in a row, so no timer; its hints stay in `deferred` until real
  //   activity on it arms one retry after its current (longest) delay.
  // Neither state blocks flush(): the chain owns its hints from then on.
  const backoff = deps.backoff || createChainBackoff()
  const deferred = new Map<string, Hint>()
  const retryTimers = new Map<string, unknown>()
  const waiters = new Set<{ generation: number; resolve: (ok: boolean) => void }>()
  let subscribed: OwnedWatch[] = []
  let receive: ((event: StreamEvent) => boolean) | undefined
  let subscribeTimer: unknown, refreshTimer: unknown
  const current = (expected: BalanceRefreshScope | null, gen = generation) => gen === generation && deps.canWatch() && sameBalanceRefreshScope(expected, deps.getScope())
  const currentSession = (expected: BalanceRefreshScope | null, gen: number) => gen === batchGeneration && deps.canWatch() && sameBalanceRefreshScope(expected, deps.getScope())
  /** The same wallet session, even while it cannot be watched right now (e.g. the device auto-locked). */
  const sameSession = (expected: BalanceRefreshScope | null, gen: number) => gen === batchGeneration && sameBalanceRefreshScope(expected, deps.getScope())
  function cancelRetry(chainId: string) {
    const timer = retryTimers.get(chainId)
    if (timer !== undefined) clearTimer(timer)
    retryTimers.delete(chainId); deferred.delete(chainId); backoff.succeed(chainId)
  }
  function pruneInactive() {
    const chains = new Set(subscribed.filter(entry => deps.isChainEnabled(entry.chainId)).map(entry => entry.chainId))
    for (const chainId of failedChains) if (!chains.has(chainId)) failedChains.delete(chainId)
    for (const chainId of pending.keys()) if (!chains.has(chainId)) pending.delete(chainId)
    for (const chainId of [...retryTimers.keys(), ...deferred.keys()]) if (!chains.has(chainId)) cancelRetry(chainId)
  }
  /** Every hint was processed or belongs to a waiting or paused chain, which owns it from here on. */
  function settle() {
    if (pending.size || running.size) return
    for (const waiter of waiters) { waiter.resolve(waiter.generation === batchGeneration && current(scope)); waiters.delete(waiter) }
  }
  function armRetry(chainId: string, delay: number, cause: 'failure' | 'activity') {
    const expected = scope, gen = batchGeneration
    deps.onRetryScheduled?.(chainId, delay, backoff.failures(chainId), cause)
    const timer = setTimer(() => {
      if (retryTimers.get(chainId) !== timer) return
      retryTimers.delete(chainId)
      const waiting = deferred.get(chainId)
      deferred.delete(chainId)
      if (!waiting) return
      // A retired wallet or a disabled chain must never run a retry armed before (drain() re-checks the session).
      // A device that is only locked keeps its hint: drain() holds `pending` until the wallet can be watched again.
      if (!sameSession(expected, gen) || !deps.isChainEnabled(chainId)) { backoff.succeed(chainId); failedChains.delete(chainId); return }
      pending.set(chainId, mergeHint(pending.get(chainId), waiting))
      drain()
    }, delay)
    retryTimers.set(chainId, timer)
  }
  /** Keeps a hint for a waiting or paused chain. Activity on a paused chain arms one retry after its current delay. */
  function park(chainId: string, hint: Hint) {
    deferred.set(chainId, mergeHint(deferred.get(chainId), hint))
    // Never sooner than the shortest delay, even if a future change parks a hint for a chain with no failure count.
    if (!retryTimers.has(chainId)) armRetry(chainId, Math.max(backoff.peek(chainId), CHAIN_RETRY_DELAYS_MS[0]!), 'activity')
  }
  function onFailed(chainId: string, hint: Hint) {
    deferred.set(chainId, mergeHint(deferred.get(chainId), hint))
    const delay = backoff.fail(chainId), failures = backoff.failures(chainId)
    if (failures > MAX_AUTO_RETRIES) { deps.onRetryPaused?.(chainId, failures); return }
    armRetry(chainId, delay, 'failure')
  }
  const waitingOrPaused = (chainId: string) => retryTimers.has(chainId) || deferred.has(chainId)

  function drain() {
    if (!current(scope)) return
    for (const [chainId, hint] of pending) {
      if (!deps.isChainEnabled(chainId)) { pending.delete(chainId); continue }
      // Waiting or paused: its retry picks this hint up, never an immediate call.
      if (waitingOrPaused(chainId)) { pending.delete(chainId); park(chainId, hint); continue }
      if (running.size >= 2) break
      if (running.has(chainId)) continue
      pending.delete(chainId)
      const job = {}; running.set(chainId, job)
      const gen = batchGeneration, expected = scope
      void deps.refresh(hint, () => currentSession(expected, gen) && deps.isChainEnabled(chainId)).then(async () => {
        if (hint.eventIds?.length && expected && currentSession(expected, gen) && deps.isChainEnabled(chainId)) await deps.onProcessed?.(hint.eventIds, expected)
        if (currentSession(expected, gen)) { failedChains.delete(chainId); backoff.succeed(chainId) }
      }).catch(error => {
        if (!currentSession(expected, gen)) return
        failedChains.add(chainId); deps.onError?.(error)
        if (deps.isChainEnabled(chainId)) onFailed(chainId, hint)
      }).finally(() => { if (running.get(chainId) === job) running.delete(chainId); drain(); settle() })
    }
    settle()
  }
  function queue(chainId: string, txid?: string, catchup = false, eventId?: string) {
    if (catchup) {
      const key = `${generation}:${chainId}`, previous = lastCatchup.get(key)
      if (previous !== undefined && now() - previous < 2_000) return
      lastCatchup.set(key, now())
    }
    const hint: Hint = { chainId, txids: txid ? [txid] : [], catchup, ...(eventId ? { eventIds: [eventId] } : {}) }
    // A waiting or paused chain collects hints for its retry instead of calling the provider again.
    if (waitingOrPaused(chainId)) { park(chainId, hint); return }
    pending.set(chainId, mergeHint(pending.get(chainId), hint))
    if (refreshTimer !== undefined) return
    refreshTimer = setTimer(() => { refreshTimer = undefined; drain() }, 150)
  }
  function subscribe() {
    subscribeTimer = undefined
    if (!current(scope)) return
    const eligible = [...owned.values()].filter(entry => deps.isChainEnabled(entry.chainId))
    const selected = selectOwnedWatches(eligible)
    const key = selected.map(ownedWatchKey).join('|')
    if (key === leaseKey) return
    const oldKeys = new Set(subscribed.map(ownedWatchKey))
    const changedChains = new Set(selected.filter(entry => !oldKeys.has(ownedWatchKey(entry))).map(entry => entry.chainId))
    subscribed = selected; leaseKey = key
    pruneInactive()
    const gen = ++generation, expected = scope
    lastCatchup.clear()
    if (!selected.length) { deps.stop(); if (expected) try { deps.onLease?.([], expected) } catch (error) { deps.onError?.(error) }; return }
    const selectedByKey = new Map(selected.map(entry => [ownedWatchKey(entry), entry]))
    const allChains = new Set(selected.map(entry => entry.chainId))
    let unsupported = new Set<string>()
    let connects = 0
    const catchup = (chains: Set<string>) => { for (const chainId of chains) if (selected.some(entry => entry.chainId === chainId && !unsupported.has(entry.networkId))) queue(chainId, undefined, true) }
    if (eligible.filter(entry => entry.account).length > selected.filter(entry => entry.account).length) deps.onOverflow?.(eligible.length - selected.length)
    receive = event => {
      if (!current(expected, gen)) return false
      const data = event.data as any
      if (event.type === 'connected') { connects++; unsupported = new Set(Array.isArray(data.unsupported) ? data.unsupported : []); catchup(connects === 1 ? changedChains : allChains); deps.onConnected?.(); return true }
      if (event.type === 'sync:required') {
        const networks = Array.isArray(data.networkIds) ? new Set(data.networkIds) : undefined
        const chains = connects <= 1 && data.reason === 'subscribe' ? changedChains : allChains
        catchup(new Set(selected.filter(entry => chains.has(entry.chainId) && (!networks || networks.has(entry.networkId))).map(entry => entry.chainId)))
        return true
      }
      if (event.type !== 'tx:incoming' && event.type !== 'tx:confirmed') return false
      const address = data?.watchedAddress || data?.watchAddress || data?.address
      if (typeof address !== 'string' || typeof data?.networkId !== 'string') return false
      const txid = typeof data.txid === 'string' && data.txid.length > 0 && data.txid.length <= 256 ? data.txid : undefined
      const watch = selectedByKey.get(ownedWatchKey({ address, networkId: data.networkId }))
      if (!watch || !deps.isChainEnabled(watch.chainId)) return false
      const stableId = data.eventId || txid || data.cursor
      const eventKey = stableId !== undefined ? `${watch.networkId}:${stableId}:${event.type}` : undefined
      for (const [key, expires] of seen) if (expires < now()) seen.delete(key)
      if (eventKey && seen.has(eventKey) && !failedChains.has(watch.chainId)) return true
      if (eventKey) seen.set(eventKey, now() + 15_000)
      queue(watch.chainId, txid, false, typeof data.eventId === 'string' ? data.eventId : undefined)
      if (event.type === 'tx:incoming' && data.type === 'incoming') deps.onIncoming?.(watch, data)
      return true
    }
    catchup(changedChains)
    if (expected) try { deps.onLease?.(selected.map(({ address, networkId }) => ({ address, networkId })), expected) } catch (error) { deps.onError?.(error) }
    deps.start(selected.map(({ address, networkId }) => ({ address, networkId })), receive, status => { if (current(expected, gen)) deps.onStatus?.(status) })
  }
  function stop() {
    generation++
    batchGeneration++; batchDepth = 0
    if (subscribeTimer !== undefined) clearTimer(subscribeTimer)
    if (refreshTimer !== undefined) clearTimer(refreshTimer)
    subscribeTimer = undefined; refreshTimer = undefined
    for (const timer of retryTimers.values()) clearTimer(timer)
    retryTimers.clear(); deferred.clear(); backoff.clear()
    deps.stop(); owned.clear(); pending.clear(); running.clear(); seen.clear(); lastCatchup.clear(); failedChains.clear()
    for (const waiter of waiters) { waiter.resolve(false); waiters.delete(waiter) }
    scope = null; subscribed = []; leaseKey = undefined; receive = undefined
    deps.onStatus?.({ connected: false, watching: 0 })
  }
  return {
    add(entries: OwnedWatch[], expected = deps.getScope()) {
      if (!expected || !sameBalanceRefreshScope(expected, deps.getScope())) return
      if (!sameBalanceRefreshScope(scope, expected)) { stop(); scope = expected }
      for (const entry of entries) {
        if (!entry.address || !entry.networkId || !entry.chainId || !deps.isChainEnabled(entry.chainId)) continue
        owned.set(ownedWatchKey(entry), entry)
      }
      if (!batchDepth && subscribeTimer === undefined) subscribeTimer = setTimer(subscribe, 250)
    },
    resume() {
      if (!scope || !current(scope) || batchDepth) return
      for (const chainId of new Set(subscribed.map(entry => entry.chainId))) queue(chainId, undefined, true)
      if (subscribeTimer === undefined) subscribeTimer = setTimer(subscribe, 0)
    },
    event(event: StreamEvent): boolean { return receive?.(event) || false },
    beginBatch() {
      const batch = batchGeneration
      batchDepth++
      if (subscribeTimer !== undefined) clearTimer(subscribeTimer)
      subscribeTimer = undefined
      return () => {
        if (batch !== batchGeneration) return
        batchDepth = Math.max(0, batchDepth - 1)
        if (!batchDepth && subscribeTimer === undefined) subscribeTimer = setTimer(subscribe, 250)
      }
    },
    flush(): Promise<boolean> {
      if (!current(scope)) return Promise.resolve(false)
      pruneInactive()
      if (!pending.size && !running.size) return Promise.resolve(true)
      return new Promise(resolve => { waiters.add({ generation: batchGeneration, resolve }); drain() })
    },
    stop,
    entries(chainId?: string): OwnedWatch[] {
      return sameBalanceRefreshScope(scope, deps.getScope()) ? [...owned.values()].filter(entry => (!chainId || entry.chainId === chainId) && deps.isChainEnabled(entry.chainId)) : []
    },
  }
}
