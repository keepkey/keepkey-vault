/**
 * Vault-side portfolio performance telemetry — the client half of the
 * vault-vs-API split (pioneer PR #164, HANDOFF-VAULT-PERFORMANCE-TELEMETRY.md).
 *
 * Every GetPortfolioBalances call is stopwatched; the server's meta.serverMs
 * is echoed back with our total so the backend can compute
 * networkMs = clientTotalMs - serverMs and attribute slow loads to the API,
 * the network, or the vault. Records are ring-buffered and flushed in batches
 * to POST /api/v1/telemetry/vault — strictly fire-and-forget: a telemetry
 * failure must never surface to the UI or block a load.
 *
 * Privacy: no pubkeys/xpubs/addresses ever — only timings + traceId. The
 * wallet is identified server-side by hashing the authed queryKey.
 *
 * Pure module: no db/device imports, safe under bun test.
 */
import pkg from '../../package.json'

export type PerfOutcome = 'ok' | 'slow' | 'timeout' | 'error' | 'degraded'

export interface PerfRecord {
  traceId?: string
  serverMs?: number
  clientTotalMs: number
  outcome: PerfOutcome
  degraded: boolean
  phases?: { networkMs?: number; parseMs?: number; renderMs?: number }
  appVersion: string
  platform: string
  at: number
}

// Thresholds from the handoff: >3s perceived = slow, >=30s = client timeout.
export const SLOW_THRESHOLD_MS = 3000
export const TIMEOUT_THRESHOLD_MS = 30_000
const BUFFER_CAP = 50
const FLUSH_AT = 20
const FLUSH_INTERVAL_MS = 60_000

export function classifyOutcome(opts: {
  errored: boolean
  clientTotalMs: number
  degraded: boolean
  errorMessage?: string
}): PerfOutcome {
  if (opts.errored) {
    const timeoutish = /timeout|timed out|abort/i.test(opts.errorMessage || '')
    return timeoutish || opts.clientTotalMs >= TIMEOUT_THRESHOLD_MS ? 'timeout' : 'error'
  }
  if (opts.degraded) return 'degraded'
  if (opts.clientTotalMs > SLOW_THRESHOLD_MS) return 'slow'
  return 'ok'
}

function platformSlug(): string {
  switch (process.platform) {
    case 'darwin': return 'desktop-mac'
    case 'win32': return 'desktop-win'
    default: return 'desktop-linux'
  }
}

export function buildRecord(opts: {
  clientTotalMs: number
  meta?: { traceId?: string; serverMs?: number; degraded?: boolean } | null
  errored?: boolean
  errorMessage?: string
}): PerfRecord {
  const degraded = opts.meta?.degraded === true
  const rec: PerfRecord = {
    clientTotalMs: Math.round(opts.clientTotalMs),
    outcome: classifyOutcome({
      errored: !!opts.errored,
      clientTotalMs: opts.clientTotalMs,
      degraded,
      errorMessage: opts.errorMessage,
    }),
    degraded,
    appVersion: pkg.version,
    platform: platformSlug(),
    at: Date.now(),
  }
  if (opts.meta?.traceId) rec.traceId = opts.meta.traceId
  if (typeof opts.meta?.serverMs === 'number') rec.serverMs = opts.meta.serverMs
  return rec
}

// --- buffer + flush ---

let cfg: { apiBase: string; queryKey: string } | null = null
const buffer: PerfRecord[] = []
let flushTimer: ReturnType<typeof setInterval> | null = null
let offline = false

function startFlushTimer(): void {
  if (offline || flushTimer || !cfg) return
  flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS)
  if (typeof (flushTimer as any).unref === 'function') (flushTimer as any).unref()
}

export function setPerfTelemetryOffline(value: boolean): void {
  offline = value
  if (offline && flushTimer) {
    clearInterval(flushTimer)
    flushTimer = null
  } else if (!offline) {
    startFlushTimer()
  }
}

export function pushRecord(rec: PerfRecord): void {
  buffer.push(rec)
  if (buffer.length > BUFFER_CAP) buffer.splice(0, buffer.length - BUFFER_CAP)
  if (buffer.length >= FLUSH_AT) void flush()
}

/** Last N records for a "report an issue" attachment — timings only, no identity. */
export function recentPerfRecords(n = 20): PerfRecord[] {
  return buffer.slice(-n)
}

let flushInFlight = false

export async function flush(): Promise<void> {
  if (offline || !cfg || buffer.length === 0 || flushInFlight) return
  flushInFlight = true
  const records = buffer.slice() // clear only on success — a failed flush retries next cycle
  try {
    const res = await fetch(`${cfg.apiBase}/api/v1/telemetry/vault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: cfg.queryKey },
      body: JSON.stringify({ records }),
    })
    if (res.ok) buffer.splice(0, records.length)
    // Non-2xx (e.g. server without the endpoint yet): keep buffer, cap drops oldest.
  } catch {
    // Best-effort: never surface telemetry failures.
  } finally {
    flushInFlight = false
  }
}

/**
 * Wrap GetPortfolioBalances on the (singleton) pioneer client so every call
 * site is instrumented in one place. Called from getPioneer() after init.
 */
export function instrumentPortfolio(client: any, options: { apiBase: string; queryKey: string }): void {
  cfg = options
  startFlushTimer()
  if (typeof client?.GetPortfolioBalances !== 'function' || client.__perfInstrumented) return
  const orig = client.GetPortfolioBalances.bind(client)
  client.GetPortfolioBalances = async (...args: any[]) => {
    const t0 = Date.now()
    try {
      const resp = await orig(...args)
      // clientTotalMs here is request→response in the bun process (no render
      // hook available server-side of the webview) — acceptable v1 per handoff.
      const rawData = resp?.data?.data || resp?.data || {}
      pushRecord(buildRecord({ clientTotalMs: Date.now() - t0, meta: rawData.meta }))
      return resp
    } catch (err: any) {
      pushRecord(buildRecord({ clientTotalMs: Date.now() - t0, errored: true, errorMessage: err?.message }))
      throw err
    }
  }
  client.__perfInstrumented = true
}
