import type { ChainDef } from '../shared/chains'
import type { ApiLogEntry } from '../shared/types'

/** Indexers may accept a broadcast before their balance endpoint sees it. */
export const POST_TX_BALANCE_DELAYS_MS = [0, 4_000, 15_000, 45_000] as const

export interface BalanceRefreshScope {
  epoch: number
  deviceId: string
  walletId: string
  wallet: object
}

export function sameBalanceRefreshScope(left: BalanceRefreshScope | null, right: BalanceRefreshScope | null): boolean {
  return !!left && !!right && left.epoch === right.epoch && left.deviceId === right.deviceId
    && left.walletId === right.walletId && left.wallet === right.wallet
}

/** Resolve successful local and REST broadcasts even when an older caller
 * omitted chainId. Ambiguous symbols never choose an arbitrary network. */
export function activityBalanceTarget(entry: ApiLogEntry, chains: ChainDef[]): { chainId: string; txid: string } | undefined {
  if (!entry.txid || entry.status < 200 || entry.status >= 300 || !['broadcast', 'swap'].includes(entry.activityType || '')) return undefined
  const meta = entry.responseBody && typeof entry.responseBody === 'object' ? entry.responseBody : {}
  if (meta.shielded) return undefined
  const explicit = typeof meta.chainId === 'string' ? chains.find(chain => chain.id === meta.chainId) : undefined
  const network = typeof meta.caip === 'string' ? meta.caip.split('/')[0] : typeof meta.networkId === 'string' ? meta.networkId : undefined
  const byNetwork = network ? chains.find(chain => chain.networkId === network) : undefined
  const matches = entry.chain ? chains.filter(chain => chain.id === entry.chain || chain.symbol === entry.chain || chain.coin === entry.chain) : []
  const chain = explicit || byNetwork || (matches.length === 1 ? matches[0] : undefined)
  return chain ? { chainId: chain.id, txid: entry.txid } : undefined
}

type Deps = {
  getScope: () => BalanceRefreshScope | null
  canRefresh: () => boolean
  /** This reader also pushes the trusted balance, without a renderer RPC round trip. */
  refresh: (params: { chainId: string; forceRefresh: true }, isCurrent: () => boolean) => Promise<unknown>
  onError?: (chainId: string, error: unknown) => void
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}
type Job = { chainId: string; txid?: string; scope: BalanceRefreshScope; attempt: number; timer?: unknown; waiting?: boolean }

/** One bounded refresh plan per wallet/chain, rearmed by confirmation. No
 * timer or in-flight reply is allowed to reach a different wallet session. */
export function createPostTxBalanceRefresh(deps: Deps) {
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer = deps.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const jobs = new Map<string, Job>()
  const running = new Set<string>()
  const current = (job: Job) => jobs.get(job.chainId) === job && sameBalanceRefreshScope(job.scope, deps.getScope())

  function cancel(job: Job) {
    if (job.timer !== undefined) clearTimer(job.timer)
    if (jobs.get(job.chainId) === job) jobs.delete(job.chainId)
  }
  function schedule(job: Job, delay: number) {
    if (!current(job)) { cancel(job); return }
    job.timer = setTimer(() => { job.timer = undefined; void run(job) }, delay)
  }
  async function run(job: Job) {
    if (!current(job)) { cancel(job); return }
    if (running.has(job.chainId)) { job.waiting = true; return }
    running.add(job.chainId)
    job.attempt++
    try {
      if (deps.canRefresh()) await deps.refresh({ chainId: job.chainId, forceRefresh: true }, () => current(job))
    } catch (error) {
      if (current(job)) deps.onError?.(job.chainId, error)
    } finally {
      running.delete(job.chainId)
    }
    const replacement = jobs.get(job.chainId)
    if (replacement && replacement !== job && replacement.waiting) {
      replacement.waiting = false
      schedule(replacement, 0)
    }
    if (!current(job)) { cancel(job); return }
    if (job.attempt >= POST_TX_BALANCE_DELAYS_MS.length) { cancel(job); return }
    schedule(job, POST_TX_BALANCE_DELAYS_MS[job.attempt])
  }
  function request(chainId: string, txid?: string, attempt = 0) {
    const scope = deps.getScope()
    if (!scope) return
    const previous = jobs.get(chainId)
    if (previous) cancel(previous)
    const job: Job = { chainId, txid, scope, attempt }
    jobs.set(chainId, job)
    schedule(job, POST_TX_BALANCE_DELAYS_MS[attempt])
  }
  return {
    request,
    /** A push handler already performed its first forced read. */
    retry(chainId: string, txid?: string) { request(chainId, txid, 1) },
    activity(entry: ApiLogEntry, chains: ChainDef[]): boolean {
      const scope = deps.getScope()
      if (!scope || (entry.sessionEpoch !== undefined && entry.sessionEpoch !== scope.epoch)
        || (entry.deviceId && entry.deviceId !== scope.deviceId) || (entry.walletId && entry.walletId !== scope.walletId)) return false
      const target = activityBalanceTarget(entry, chains)
      if (!target) return false
      request(target.chainId, target.txid)
      return true
    },
    clear() { for (const job of jobs.values()) cancel(job) },
    size() { return jobs.size },
  }
}
