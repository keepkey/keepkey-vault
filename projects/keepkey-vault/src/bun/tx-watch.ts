/**
 * Pending-tx watcher. After a broadcast (in-app, REST, swap) or a chain push
 * names a tx, rescan that one chain until the tx reaches its confirmation
 * target — so the activity list and balances follow the tx without anyone
 * pressing refresh.
 *
 * Scheduling logic only: the scan, the balance resync and the confirmation
 * targets are injected (index.ts wires them to rebuildActivityHistory + UI).
 */
import type { RecentActivity } from '../shared/types'
import { createChainBackoff, type ChainBackoff } from './chain-backoff'

export type TxWatchDeps = {
  /** Rescan one chain from the indexer; resolves to that chain's rows. `forceRefresh` is false while the chain is
   *  backing off after a failure, so a struggling provider is not asked to bypass its cache. */
  scanChain: (chainId: string, txids?: string[], options?: { forceRefresh?: boolean }) => Promise<RecentActivity[]>
  /** A watched tx just landed in a block — the chain's balance moved. */
  onConfirmed: (chainId: string, txid: string) => void
  requiredConfs: (row: RecentActivity) => number
  // Injected for tests only.
  backoff?: ChainBackoff
  log?: (message: string) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  now?: () => number
}

// Indexers lag a broadcast by seconds: look fast first, then once a minute.
export const RESCAN_DELAYS_MS = [5_000, 15_000, 30_000, 60_000]
// Never showed up in history: dropped, replaced, or on an account the scan
// doesn't cover (it scans account 0). Stop burning indexer calls on it.
export const UNSEEN_GIVE_UP_MS = 15 * 60_000
// Seen but short of its target (stuck low-fee tx, ZEC's 24 confs): stop eventually.
export const MAX_WATCH_MS = 3 * 60 * 60_000

// `since` is the give-up clock: time a chain spent failing is added back to it, so a provider outage never uses up a
// tx's chances to be seen. `added` is the real start, for the MAX_WATCH_MS hard stop while a chain keeps failing.
type Watched = { chainId: string; txid: string; since: number; added: number; scans: number; seen: boolean; inBlock: boolean }

export function createTxWatch(deps: TxWatchDeps) {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((message: string) => console.warn(message))
  // A chain whose rescan failed waits longer each time (KEEPKEY-207, same delays as KEEPKEY-109's refresh backoff)
  // instead of being asked again every minute; one success resets it.
  const backoff = deps.backoff ?? createChainBackoff()
  const failingSince = new Map<string, number>() // chainId → start of its current failure sequence
  const watched = new Map<string, Watched>() // `${chainId}:${txid}`
  const timers = new Map<string, { timer: unknown; due: number }>() // one queued scan per chain
  const running = new Set<string>()
  const rerun = new Set<string>()
  // Bumped by clear() so a scan that finishes after a disconnect / wallet switch
  // can't resurrect watches or reschedule for the previous wallet.
  let generation = 0

  function schedule(chainId: string, ms: number): void {
    const due = now() + ms
    const queued = timers.get(chainId)
    if (queued && queued.due <= due) return
    if (queued) clearTimer(queued.timer)
    timers.set(chainId, { due, timer: setTimer(() => { timers.delete(chainId); void scan(chainId) }, ms) })
  }

  /** Delay for a scan asked for now: as asked when the chain is healthy; while it backs off, at least its current
   *  backoff delay, so a push or a new tx cannot cut the wait short. */
  const earliest = (chainId: string, ms: number) => backoff.failures(chainId) ? Math.max(ms, backoff.peek(chainId)) : ms

  function nextDelay(chainId: string): number | null {
    let scans = Infinity
    for (const w of watched.values()) if (w.chainId === chainId) scans = Math.min(scans, w.scans)
    return scans === Infinity ? null : RESCAN_DELAYS_MS[Math.min(scans, RESCAN_DELAYS_MS.length - 1)]
  }

  function settle(chainId: string, rows: RecentActivity[] | null): void {
    const byTxid = new Map((rows || []).filter(r => r.txid).map(r => [r.txid!, r]))
    const t = now()
    for (const [key, w] of watched) {
      if (w.chainId !== chainId) continue
      w.scans++
      const row = byTxid.get(w.txid)
      if (row) {
        w.seen = true
        // Absent confirmations = this chain's history isn't annotated (Solana,
        // Tendermint): being in history at all means it's on-chain and final.
        const confs = row.confirmations
        if (!w.inBlock && (confs === undefined || confs >= 1)) {
          w.inBlock = true
          deps.onConfirmed(chainId, w.txid)
        }
        if (confs === undefined || confs >= deps.requiredConfs(row)) { watched.delete(key); continue }
      }
      if (t - w.since > (w.seen ? MAX_WATCH_MS : UNSEEN_GIVE_UP_MS) || t - w.added > MAX_WATCH_MS) watched.delete(key)
    }
  }

  /** A failed rescan proves nothing about the txs: no settle, no give-up. Only the 3 h hard stop still applies.
   *  The retry waits for the chain's backoff delay or the txs' current step on the normal ladder, whichever is longer.
   *  Failures do not move that step, so a fresh watch on a failing chain retries at 5, 15, 30, 60, then every 120 s. */
  function onFailed(chainId: string, error: any): number | null {
    const t = now()
    const failures = backoff.failures(chainId) + 1
    const delay = backoff.fail(chainId)
    if (failures === 1) {
      failingSince.set(chainId, t)
      log(`[tx-watch] ${chainId} rescan failed, retrying with backoff: ${error?.message || error}`)
    }
    for (const [key, w] of watched) if (w.chainId === chainId && t - w.added > MAX_WATCH_MS) watched.delete(key)
    const normal = nextDelay(chainId)
    if (normal === null) {
      // The hard stop ended the chain's last watch: nothing is scheduled any more, so forget the failure sequence.
      // A tx watched later starts fresh instead of at the longest delay with hours of "outage" added to its clock.
      backoff.succeed(chainId)
      failingSince.delete(chainId)
      return null
    }
    return Math.max(normal, delay)
  }

  /** Back from a failure sequence: the outage does not count toward giving up on the chain's txs. */
  function onRecovered(chainId: string): void {
    const started = failingSince.get(chainId)
    if (started === undefined) return
    const failures = backoff.failures(chainId)
    failingSince.delete(chainId)
    backoff.succeed(chainId)
    const outage = now() - started
    for (const w of watched.values()) if (w.chainId === chainId) w.since += outage
    log(`[tx-watch] ${chainId} rescan recovered after ${failures} failure(s)`)
  }

  async function scan(chainId: string): Promise<void> {
    if (running.has(chainId)) { rerun.add(chainId); return }
    running.add(chainId)
    const gen = generation
    let rows: RecentActivity[] | null = null
    let error: unknown = null
    try {
      rows = await deps.scanChain(chainId, [...watched.values()].filter(row=>row.chainId===chainId).map(row=>row.txid),
        { forceRefresh: backoff.failures(chainId) === 0 })
    } catch (e: any) {
      error = e ?? new Error('rescan failed')
    } finally {
      running.delete(chainId)
    }
    if (gen !== generation) {
      // These rows belong to the previous session — don't settle them. clear()
      // emptied rerun/watched, so anything there now was queued by the new
      // session while this stale scan held the chain: don't strand it.
      const d = rerun.delete(chainId) ? 0 : nextDelay(chainId)
      if (d !== null) schedule(chainId, d)
      return
    }
    if (error !== null) {
      // A rerun asked for while this scan was failing waits for the backoff too.
      rerun.delete(chainId)
      const delay = onFailed(chainId, error)
      if (delay !== null) schedule(chainId, delay)
      return
    }
    onRecovered(chainId)
    settle(chainId, rows)
    const delay = rerun.delete(chainId) ? 0 : nextDelay(chainId)
    if (delay !== null) schedule(chainId, delay)
  }

  return {
    /** Follow a tx until it confirms (idempotent per chain+txid). */
    watch(chainId: string, txid: string): void {
      const key = `${chainId}:${txid}`
      const t = now()
      if (!watched.has(key)) watched.set(key, { chainId, txid, since: t, added: t, scans: 0, seen: false, inBlock: false })
      schedule(chainId, earliest(chainId, RESCAN_DELAYS_MS[0]))
    },
    /** Rescan a chain once soon (a push that named no txid). A chain backing off keeps its delay. */
    poke(chainId: string): void {
      schedule(chainId, earliest(chainId, RESCAN_DELAYS_MS[0]))
    },
    /** Drop everything — disconnect, passphrase prompt, seed change. */
    clear(): void {
      generation++
      for (const q of timers.values()) clearTimer(q.timer)
      timers.clear()
      watched.clear()
      rerun.clear()
      backoff.clear()
      failingSince.clear()
    },
    size(): number { return watched.size },
  }
}
