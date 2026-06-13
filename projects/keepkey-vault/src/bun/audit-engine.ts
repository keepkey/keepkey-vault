/**
 * Audit engine — orchestrates the multi-chain "where's my money" wizard.
 *
 * Phases (sequential, device-bound): identity → btc → evm → coverage. Reuses
 * sweep-engine (BTC path discovery) and an injected EVM auto-discover; fixed-
 * address chains can only be coverage-checked (see audit-coverage.ts).
 *
 * Safety (per the design-hardening review):
 *  - Identity is READ-ONLY (deriveSeedIdentity) — never the purge-capable
 *    ensureManagersForSeed. A mismatch is surfaced as a finding, never acted on.
 *  - The BTC loop is gen-guarded: it captures the wallet handle and aborts to
 *    status 'aborted' (NEVER 'complete') if the handle changes (reconnect /
 *    purge) or the device goes unresponsive — so a partial scan is never
 *    presented as a clean bill of health, and stale-seed UTXOs never feed a sign.
 *  - Device IO itself is serialized by the keepkey transport (callInProgress),
 *    so concurrent background syncs interleave safely.
 *
 * Dependency-injected so this module never imports the engine/db directly
 * (keeps imports light; the pure classifier in audit-coverage.ts is the test
 * surface).
 */
import {
  generatePathMatrix,
  checkAddressBalance,
  fetchUtxos,
  type PathEntry,
  type SweepAddress,
} from './sweep-engine'
import { AUDIT_CONFIGS, classifyCoverage, summarizeCoverage, type AuditChainInput } from './audit-coverage'
import type { AuditMode, AuditReport, AuditPortfolioSnapshot } from '../shared/types'

const TAG = '[audit]'
const MAX_RETAINED = 5
const TTL_MS = 30 * 60 * 1000 // 30 min
const MAX_CONSECUTIVE_FAILURES = 5

export interface AuditDeps {
  /** The hdwallet handle captured at audit start. */
  wallet: any
  /** Returns the engine's CURRENT wallet handle — the gen-guard compares it to
   *  the captured one to detect a reconnect/purge mid-scan. */
  currentWallet: () => any
  /** Read-only seed identity (e.g. EVM idx0 address) derived from the device. */
  deriveSeedIdentity: () => Promise<string | null>
  /** The EVM idx0 address the account managers currently track. */
  evmIdx0: () => string | null
  /** Enabled chains for the coverage classifier (subset of ChainDef). */
  coverageChains: AuditChainInput[]
  /** User's highest tracked BTC account index. */
  btcCurrentMaxAccount: number
  isHidden: boolean
  deviceId: string
}

interface AuditEntry {
  report: AuditReport
  /** Raw sweep results (with utxos) — backend-only, feeds buildSweepTx. */
  btcRaw: SweepAddress[]
  capturedWallet: any
  deps: AuditDeps
  /** Sticky: set by markAuditsStale (a seed purge fired underneath the run).
   *  The worker checks it and refuses to finalize 'complete'. Unlike the
   *  wallet-object gen-guard, this catches a same-handle seed change (passphrase
   *  toggle) that reuses engine.wallet. */
  staled: boolean
}

const audits = new Map<string, AuditEntry>()

export function getAudit(id: string): AuditReport | undefined {
  return audits.get(id)?.report
}

/** Backend-only accessor for the raw BTC sweep results (for buildSweepTx). */
export function getAuditBtcRaw(id: string): SweepAddress[] | undefined {
  return audits.get(id)?.btcRaw
}

export function getAuditEntry(id: string): { capturedWallet: any; report: AuditReport } | undefined {
  const e = audits.get(id)
  return e ? { capturedWallet: e.capturedWallet, report: e.report } : undefined
}

export function dismissAudit(id: string): void {
  audits.delete(id)
}

/** Mark every audit stale — call when a seed purge yanks data from under an open
 *  wizard (the run's findings are no longer authoritative). Sets a sticky flag
 *  (so a still-running worker can't finalize 'complete' over it) AND flips a
 *  running report's status. A completed report keeps its status but is flagged,
 *  so auditSweep's live re-check refuses it. */
export function markAuditsStale(reason: string): void {
  for (const e of audits.values()) {
    e.staled = true
    if (e.report.status === 'running') {
      e.report.status = 'stale'
      e.report.error = reason
      e.report.completedAt = Date.now()
    }
  }
}

function reap(): void {
  const now = Date.now()
  for (const [id, e] of audits) {
    const done = e.report.status !== 'running'
    if (done && e.report.completedAt && now - e.report.completedAt > TTL_MS) audits.delete(id)
  }
  const finished = [...audits.entries()]
    .filter(([, e]) => e.report.status !== 'running')
    .sort((a, b) => (a[1].report.completedAt || 0) - (b[1].report.completedAt || 0))
  while (finished.length > MAX_RETAINED) {
    const [id] = finished.shift()!
    audits.delete(id)
  }
}

/** Start an audit. Idempotent singleton: if one is already running for the same
 *  captured wallet, returns its id instead of spawning a second worker. */
export function startAudit(deps: AuditDeps, mode: AuditMode, snapshot: AuditPortfolioSnapshot): string {
  reap()
  for (const [id, e] of audits) {
    if (e.report.status === 'running' && e.capturedWallet === deps.wallet) return id
  }

  const id = crypto.randomUUID()
  const report: AuditReport = {
    auditId: id,
    status: 'running',
    mode,
    isHidden: deps.isHidden,
    phase: 'identity',
    progress: { current: 0, total: 1, label: 'Verifying device…' },
    startedAt: Date.now(),
    seedIdentity: null,
    identityMismatch: false,
    chains: [],
    btcScanState: 'idle',
    btc: { findings: [], totalFoundSats: 0, higherAccountMax: 0, partial: false },
    evm: { discoveredIndices: [], persisted: !deps.isHidden },
    anyUnverified: false,
    anyShallow: false,
  }
  const entry: AuditEntry = { report, btcRaw: [], capturedWallet: deps.wallet, deps, staled: false }
  audits.set(id, entry)

  auditWorker(entry, snapshot).catch(e => {
    report.status = 'error'
    report.error = e?.message || String(e)
    report.completedAt = Date.now()
    console.error(`${TAG} audit ${id} failed:`, e)
  })
  return id
}

// Live = the device handle hasn't been replaced (reconnect/purge) AND no seed
// purge flagged this run stale (same-handle passphrase toggle). Both must hold
// for the worker to keep going / finalize.
function isLive(entry: AuditEntry): boolean {
  return entry.deps.currentWallet() === entry.capturedWallet && !entry.staled
}

function abort(report: AuditReport, reason: string): void {
  report.status = 'aborted'
  report.error = reason
  report.completedAt = Date.now()
  console.warn(`${TAG} audit ${report.auditId} aborted: ${reason}`)
}

async function deriveBtcAddress(wallet: any, path: number[], scriptType: string): Promise<string> {
  const r = await wallet.btcGetAddress({ addressNList: path, coin: 'Bitcoin', scriptType, showDisplay: false })
  return typeof r === 'string' ? r : r?.address
}

async function auditWorker(entry: AuditEntry, snapshot: AuditPortfolioSnapshot): Promise<void> {
  const { report, deps } = entry

  // ── Phase: identity (READ-ONLY) ──
  report.phase = 'identity'
  report.progress = { current: 0, total: 1, label: 'Verifying device identity…' }
  let seedIdentity: string | null = null
  try {
    seedIdentity = await deps.deriveSeedIdentity()
  } catch (e: any) {
    console.warn(`${TAG} deriveSeedIdentity failed (non-fatal): ${e?.message}`)
  }
  report.seedIdentity = seedIdentity
  const evmIdx0 = deps.evmIdx0()
  if (seedIdentity && evmIdx0 && seedIdentity.toLowerCase() !== evmIdx0.toLowerCase()) {
    report.identityMismatch = true
  }
  if (!isLive(entry)) return abort(report, 'device changed during audit')

  // ── Phase: coverage (pure, instant) ──
  // No device scanning here — auditStart goes STRAIGHT into the walkthrough.
  // BTC paths are scanned lazily on the Bitcoin page (startBtcScan); EVM and
  // other accounts are scanned lazily per page via the frontend's
  // auditScanLevels. We never scan up front what the pages scan again. `lazy`
  // keeps non-funded chains as 'checked-shallow' until a page confirms them.
  report.phase = 'coverage'
  report.progress = { current: 0, total: 1, label: 'Reviewing your chains…' }
  report.chains = classifyCoverage(deps.coverageChains, snapshot, false, true)
  const summary = summarizeCoverage(report.chains, snapshot)
  report.anyUnverified = summary.anyUnverified
  report.anyShallow = summary.anyShallow

  report.phase = 'done'
  report.status = 'complete'
  report.completedAt = Date.now()
  console.log(`${TAG} audit ${report.auditId} ready: ${report.chains.length} chains (lazy scan per page)`)
}

/** Lazy Bitcoin path scan — runs the gen-guarded derive loop on demand (when the
 *  user opens the Bitcoin page). Populates report.btc + entry.btcRaw + progress
 *  and flips btcScanState. Does NOT touch report.status (the audit is already
 *  'complete'). Idempotent. */
export function startBtcScan(auditId: string): boolean {
  const entry = audits.get(auditId)
  if (!entry) return false
  // Only short-circuit on genuinely in-progress / finished scans. From 'idle' OR
  // 'error' we (re)start — a Retry after a failed scan MUST actually re-run.
  if (entry.report.btcScanState === 'scanning' || entry.report.btcScanState === 'done') return true
  // Reset accumulators so a retry from a partial 'error' doesn't double-count.
  entry.btcRaw = []
  entry.report.btc = { findings: [], totalFoundSats: 0, higherAccountMax: 0, partial: false }
  entry.report.btcScanState = 'scanning'
  runBtcScan(entry).catch(e => {
    entry.report.btcScanState = 'error'
    entry.report.btc.partial = true
    console.error(`${TAG} btc scan ${auditId} failed:`, e)
  })
  return true
}

async function runBtcScan(entry: AuditEntry): Promise<void> {
  const { report, deps } = entry
  const config = AUDIT_CONFIGS[report.mode]
  const matrix: PathEntry[] = generatePathMatrix({
    accountRange: config.accountRange,
    mismatchAccounts: config.mismatchAccounts,
    currentMaxAccount: deps.btcCurrentMaxAccount,
    higherAccountScanLimit: Math.min(deps.btcCurrentMaxAccount + config.higherAccountScanLimit, 19),
    gapLimitReceive: config.gapLimitReceive,
    gapLimitChange: config.gapLimitChange,
    higherReceiveLimit: config.higherReceiveLimit,
  })
  report.progress = { current: 0, total: matrix.length, label: 'Scanning Bitcoin paths…' }

  const derived: Array<PathEntry & { address: string }> = []
  let consecutiveFailures = 0
  for (let i = 0; i < matrix.length; i++) {
    if (!isLive(entry)) { report.btc.partial = true; report.btcScanState = 'error'; return }
    const e = matrix[i]
    try {
      const address = await deriveBtcAddress(deps.wallet, e.path, e.scriptType)
      consecutiveFailures = 0
      if (address) derived.push({ ...e, address })
    } catch (err: any) {
      consecutiveFailures++
      console.warn(`${TAG} derive failed (${e.pathStr} as ${e.scriptType}): ${err?.message}`)
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) { report.btc.partial = true; report.btcScanState = 'error'; return }
    }
    report.progress.current = i + 1
  }

  report.progress = { current: 0, total: derived.length, label: 'Checking Bitcoin balances…' }
  const BATCH = 5
  for (let i = 0; i < derived.length; i += BATCH) {
    if (!isLive(entry)) { report.btc.partial = true; report.btcScanState = 'error'; return }
    const batch = derived.slice(i, i + BATCH)
    const results = await Promise.all(batch.map(async (e) => ({ ...e, balanceSats: await checkAddressBalance(e.address) })))
    for (const r of results) {
      if (r.balanceSats > 0) {
        const utxos = await fetchUtxos(r.address)
        entry.btcRaw.push({ path: r.path, pathStr: r.pathStr, scriptType: r.scriptType, address: r.address, category: r.category, accountIndex: r.accountIndex, balanceSats: r.balanceSats, utxos })
        report.btc.findings.push({ path: r.pathStr, scriptType: r.scriptType, address: r.address, category: r.category, accountIndex: r.accountIndex, balanceSats: r.balanceSats, utxoCount: utxos.length })
        report.btc.totalFoundSats += r.balanceSats
        if (r.category === 'higher-account' && r.accountIndex != null) report.btc.higherAccountMax = Math.max(report.btc.higherAccountMax, r.accountIndex)
      }
    }
    report.progress.current = Math.min(i + BATCH, derived.length)
  }
  report.btcScanState = 'done'
  console.log(`${TAG} btc scan ${report.auditId} done: ${report.btc.findings.length} findings, ${report.btc.totalFoundSats} sats`)
}
