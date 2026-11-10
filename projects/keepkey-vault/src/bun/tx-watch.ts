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

export type TxWatchDeps = {
  /** Rescan one chain from the indexer; resolves to that chain's rows. */
  scanChain: (chainId: string, txids?: string[]) => Promise<RecentActivity[]>
  /** A watched tx just landed in a block — the chain's balance moved. */
  onConfirmed: (chainId: string, txid: string) => void
  requiredConfs: (row: RecentActivity) => number
  // Injected for tests only.
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

type Watched = { chainId: string; txid: string; since: number; scans: number; seen: boolean; inBlock: boolean }

export function createTxWatch(deps: TxWatchDeps) {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const now = deps.now ?? Date.now
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
      if (t - w.since > (w.seen ? MAX_WATCH_MS : UNSEEN_GIVE_UP_MS)) watched.delete(key)
    }
  }

  async function scan(chainId: string): Promise<void> {
    if (running.has(chainId)) { rerun.add(chainId); return }
    running.add(chainId)
    const gen = generation
    let rows: RecentActivity[] | null = null
    try {
      rows = await deps.scanChain(chainId, [...watched.values()].filter(row=>row.chainId===chainId).map(row=>row.txid))
    } catch (e: any) {
      console.warn(`[tx-watch] ${chainId} rescan failed:`, e?.message || e)
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
    // A failed scan still counts toward backoff and give-up.
    settle(chainId, rows)
    const delay = rerun.delete(chainId) ? 0 : nextDelay(chainId)
    if (delay !== null) schedule(chainId, delay)
  }

  return {
    /** Follow a tx until it confirms (idempotent per chain+txid). */
    watch(chainId: string, txid: string): void {
      const key = `${chainId}:${txid}`
      if (!watched.has(key)) watched.set(key, { chainId, txid, since: now(), scans: 0, seen: false, inBlock: false })
      schedule(chainId, RESCAN_DELAYS_MS[0])
    },
    /** Rescan a chain once soon (a push that named no txid). */
    poke(chainId: string): void {
      schedule(chainId, RESCAN_DELAYS_MS[0])
    },
    /** Drop everything — disconnect, passphrase prompt, seed change. */
    clear(): void {
      generation++
      for (const q of timers.values()) clearTimer(q.timer)
      timers.clear()
      watched.clear()
      rerun.clear()
    },
    size(): number { return watched.size },
  }
}
