/**
 * Auditor-grade REST endpoints for the double-entry accounting ledger.
 *
 * All routes require auth and are scoped to the active device.
 *
 * Routes:
 *   GET  /api/v1/ledger/trial-balance      Current balances per account (?at=epoch&type=&asset=&chainId=)
 *   GET  /api/v1/ledger/accounts           List all accounts
 *   GET  /api/v1/ledger/accounts/:id       Account statement with running balance (?since=&until=)
 *   GET  /api/v1/ledger/journal            Paginated journal (?since=&until=&type=&asset=&txid=&q=&limit=&offset=)
 *   GET  /api/v1/ledger/journal/:id        Single entry + postings + balance check
 *   POST /api/v1/ledger/checkpoints        Create named checkpoint
 *   GET  /api/v1/ledger/checkpoints        List checkpoints
 *   GET  /api/v1/ledger/checkpoints/:id    Get checkpoint (?diff=true for delta vs current)
 *   POST /api/v1/ledger/replay             Re-derive all entries from swap_history + api_log
 *   GET  /api/v1/ledger/reconcile          Ledger vs on-chain balance comparison
 *   GET  /api/v1/ledger/segment            P&L grouped by period (?period=day|week|month&since=&until=&asset=)
 *   GET  /api/v1/ledger/missing            Unrecorded swaps/txs + reconciliation gaps
 *   GET  /api/v1/ledger/audit              Full integrity check
 *   GET  /api/v1/ledger/export.csv         CSV download of all journal entries
 *   POST /api/v1/ledger/manual             Insert manual adjustment entry
 */
import type { EngineController } from './engine-controller'
import type { AuthStore } from './auth'
import { HttpError } from './auth'
import {
  getTrialBalance,
  getAccountStatement,
  getJournalFiltered,
  getJournalEntry,
  createCheckpoint,
  listCheckpoints,
  getCheckpoint,
  replayLedger,
  reconcileLedger,
  getSegment,
  getMissingEntries,
  auditLedger,
  exportLedgerCsv,
  insertManualEntry,
  type LedgerPosting,
  type AccountType,
} from './ledger'
import { getDb } from './db'

type JsonFn = (data: unknown, status?: number) => Response

function requireDevice(engine: EngineController): string {
  const deviceId = engine.getDeviceState().deviceId
  if (!deviceId) throw new HttpError(409, 'No device connected')
  return deviceId
}

function parseEpoch(raw: string | null): number | undefined {
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `Invalid timestamp: ${raw}`)
  return n
}

function parseLimit(raw: string | null, max = 500): number {
  if (!raw) return 50
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) throw new HttpError(400, `Invalid limit: ${raw}`)
  return Math.min(n, max)
}

export async function handleLedgerRoute(
  path: string,
  method: string,
  req: Request,
  engine: EngineController,
  auth: AuthStore,
  json: JsonFn,
): Promise<Response | null> {
  if (!path.startsWith('/api/v1/ledger')) return null

  auth.requireAuth(req)
  const url = new URL(req.url)
  const sp = url.searchParams

  // ── Trial balance ─────────────────────────────────────────────────
  if (path === '/api/v1/ledger/trial-balance' && method === 'GET') {
    const deviceId = requireDevice(engine)
    const at = parseEpoch(sp.get('at'))
    const typeFilter = sp.get('type')
    const assetFilter = sp.get('asset')
    const chainFilter = sp.get('chainId')

    let rows = getTrialBalance(deviceId, at)
    if (typeFilter) rows = rows.filter(r => r.accountType === typeFilter)
    if (assetFilter) rows = rows.filter(r => r.asset === assetFilter)
    if (chainFilter) rows = rows.filter(r => r.chainId === chainFilter)

    const assetBal = new Map<string, number>()
    for (const r of rows) {
      if (r.accountType === 'asset') assetBal.set(r.asset, (assetBal.get(r.asset) ?? 0) + r.balance)
    }
    const totalAssets = [...assetBal.entries()].map(([asset, balance]) => ({ asset, balance }))

    return json({ at: at ?? null, accountCount: rows.length, totalAssets, accounts: rows })
  }

  // ── List accounts ─────────────────────────────────────────────────
  if (path === '/api/v1/ledger/accounts' && method === 'GET') {
    const deviceId = requireDevice(engine)
    const db = getDb()
    if (!db) return json({ accounts: [] })

    type Row = { id: string; type: string; asset: string; chain_id: string; created_at: number }
    const accounts = db.query(
      `SELECT a.id, a.type, a.asset, a.chain_id, a.created_at,
         COALESCE(SUM(p.amount), 0) AS balance
       FROM ledger_accounts a
       LEFT JOIN postings p ON p.account_id = a.id
       WHERE a.device_id = ?
       GROUP BY a.id
       ORDER BY a.type, a.asset`
    ).all(deviceId) as Array<Row & { balance: number }>

    return json({ count: accounts.length, accounts: accounts.map(a => ({ id: a.id, type: a.type, asset: a.asset, chainId: a.chain_id, balance: a.balance, createdAt: a.created_at })) })
  }

  // ── Account statement ─────────────────────────────────────────────
  if (path.startsWith('/api/v1/ledger/accounts/') && method === 'GET') {
    const deviceId = requireDevice(engine)
    const accountId = decodeURIComponent(path.slice('/api/v1/ledger/accounts/'.length))
    const since = parseEpoch(sp.get('since'))
    const until = parseEpoch(sp.get('until'))
    const stmt = getAccountStatement(deviceId, accountId, since, until)
    if (!stmt) return json({ error: 'Account not found', accountId }, 404)
    return json(stmt)
  }

  // ── Single journal entry ──────────────────────────────────────────
  // Must come before the /journal list route
  if (path.startsWith('/api/v1/ledger/journal/') && method === 'GET') {
    const deviceId = requireDevice(engine)
    const entryId = path.slice('/api/v1/ledger/journal/'.length)
    const entry = getJournalEntry(deviceId, entryId)
    if (!entry) return json({ error: 'Journal entry not found', id: entryId }, 404)

    // Verify it still balances
    const assetTotals = new Map<string, number>()
    for (const p of entry.postings) assetTotals.set(p.asset, (assetTotals.get(p.asset) ?? 0) + p.amount)
    const balanceCheck = [...assetTotals.entries()].map(([asset, total]) => ({ asset, sum: total, balanced: Math.abs(total) < 1e-9 }))
    const allBalanced = balanceCheck.every(c => c.balanced)

    return json({ ...entry, balanceCheck, allBalanced })
  }

  // ── Journal list ──────────────────────────────────────────────────
  if (path === '/api/v1/ledger/journal' && method === 'GET') {
    const deviceId = requireDevice(engine)
    const { entries, total } = getJournalFiltered({
      deviceId,
      since: parseEpoch(sp.get('since')),
      until: parseEpoch(sp.get('until')),
      entryType: sp.get('type') ?? undefined,
      asset: sp.get('asset') ?? undefined,
      txid: sp.get('txid') ?? undefined,
      q: sp.get('q') ?? undefined,
      limit: parseLimit(sp.get('limit')),
      offset: Number(sp.get('offset') ?? 0),
    })
    return json({ total, count: entries.length, entries })
  }

  // ── Checkpoints: create ───────────────────────────────────────────
  if (path === '/api/v1/ledger/checkpoints' && method === 'POST') {
    const deviceId = requireDevice(engine)
    let body: { name?: string } = {}
    try { body = await req.json() } catch {}
    const name = body.name || `Checkpoint ${new Date().toISOString()}`
    const id = createCheckpoint(deviceId, name)
    return json({ id, name, createdAt: Date.now() }, 201)
  }

  // ── Checkpoints: list ─────────────────────────────────────────────
  if (path === '/api/v1/ledger/checkpoints' && method === 'GET') {
    const deviceId = requireDevice(engine)
    return json({ checkpoints: listCheckpoints(deviceId) })
  }

  // ── Checkpoints: get ──────────────────────────────────────────────
  if (path.startsWith('/api/v1/ledger/checkpoints/') && method === 'GET') {
    const deviceId = requireDevice(engine)
    const checkpointId = path.slice('/api/v1/ledger/checkpoints/'.length)
    const cp = getCheckpoint(checkpointId, deviceId)
    if (!cp) return json({ error: 'Checkpoint not found', id: checkpointId }, 404)
    const includeDiff = sp.get('diff') !== 'false'
    if (!includeDiff) return json({ ...cp, diff: undefined })
    return json(cp)
  }

  // ── Replay ────────────────────────────────────────────────────────
  if (path === '/api/v1/ledger/replay' && method === 'POST') {
    const deviceId = requireDevice(engine)
    const result = replayLedger(deviceId)
    return json(result)
  }

  // ── Reconcile ─────────────────────────────────────────────────────
  if (path === '/api/v1/ledger/reconcile' && method === 'GET') {
    const deviceId = requireDevice(engine)
    const rows = reconcileLedger(deviceId)
    const inSyncCount = rows.filter(r => r.inSync).length
    const outOfSyncCount = rows.length - inSyncCount
    return json({ inSync: outOfSyncCount === 0, inSyncCount, outOfSyncCount, chains: rows })
  }

  // ── Segment / P&L ─────────────────────────────────────────────────
  if (path === '/api/v1/ledger/segment' && method === 'GET') {
    const deviceId = requireDevice(engine)
    const periodRaw = sp.get('period') ?? 'month'
    if (!['day', 'week', 'month'].includes(periodRaw)) throw new HttpError(400, `Invalid period: ${periodRaw} (day|week|month)`)
    const rows = getSegment(
      deviceId,
      periodRaw as 'day' | 'week' | 'month',
      parseEpoch(sp.get('since')),
      parseEpoch(sp.get('until')),
      sp.get('asset') ?? undefined,
    )
    return json({ period: periodRaw, rowCount: rows.length, rows })
  }

  // ── Missing money finder ──────────────────────────────────────────
  if (path === '/api/v1/ledger/missing' && method === 'GET') {
    const deviceId = requireDevice(engine)
    const missing = getMissingEntries(deviceId)
    const byKind: Record<string, number> = {}
    for (const m of missing) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1
    return json({
      total: missing.length,
      byKind,
      items: missing,
      summary: missing.length === 0
        ? 'No missing entries detected — ledger is fully reconciled.'
        : `Found ${missing.length} issue(s). Run POST /api/v1/ledger/replay to re-derive entries, then GET /api/v1/ledger/reconcile to verify.`,
    })
  }

  // ── Audit ─────────────────────────────────────────────────────────
  if (path === '/api/v1/ledger/audit' && method === 'GET') {
    const deviceId = requireDevice(engine)
    const result = auditLedger(deviceId)
    const failedChecks = result.checks.filter(c => !c.passed)
    return json({
      ...result,
      failedCount: failedChecks.length,
      status: result.passed ? 'PASS' : 'FAIL',
      verdict: result.passed
        ? 'Ledger integrity verified — all checks passed.'
        : `${failedChecks.length} check(s) failed: ${failedChecks.map(c => c.name).join(', ')}`,
    }, result.passed ? 200 : 200)
  }

  // ── CSV export ────────────────────────────────────────────────────
  if (path === '/api/v1/ledger/export.csv' && method === 'GET') {
    const deviceId = requireDevice(engine)
    const csv = exportLedgerCsv(deviceId)
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="ledger-${deviceId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.csv"`,
        'Access-Control-Allow-Origin': '*',
      },
    })
  }

  // ── Manual entry ──────────────────────────────────────────────────
  if (path === '/api/v1/ledger/manual' && method === 'POST') {
    const deviceId = requireDevice(engine)
    let body: { description?: string; postings?: any[] } = {}
    try { body = await req.json() } catch {}
    if (!body.description) throw new HttpError(400, 'description required')
    if (!Array.isArray(body.postings) || body.postings.length < 2) throw new HttpError(400, 'postings array with at least 2 entries required')

    const VALID_ACCOUNT_TYPES = new Set<string>(['asset', 'equity', 'income', 'expense'])
    const postings: LedgerPosting[] = body.postings.map((p: any, i: number) => {
      if (!p.accountId || typeof p.accountId !== 'string') throw new HttpError(400, `postings[${i}].accountId required`)
      if (!p.accountType || !VALID_ACCOUNT_TYPES.has(p.accountType)) throw new HttpError(400, `postings[${i}].accountType must be one of: ${[...VALID_ACCOUNT_TYPES].join(', ')}`)
      if (!p.asset || typeof p.asset !== 'string') throw new HttpError(400, `postings[${i}].asset required`)
      if (!p.chainId || typeof p.chainId !== 'string') throw new HttpError(400, `postings[${i}].chainId required`)
      if (typeof p.amount !== 'number' || !Number.isFinite(p.amount)) throw new HttpError(400, `postings[${i}].amount must be a finite number`)
      return { accountId: p.accountId, accountType: p.accountType as AccountType, asset: p.asset, chainId: p.chainId, amount: p.amount }
    })

    const id = insertManualEntry({ deviceId, description: body.description, postings })
    if (!id) throw new HttpError(422, 'Journal entry rejected — postings do not balance per asset')
    return json({ id, description: body.description, postings }, 201)
  }

  return null
}
