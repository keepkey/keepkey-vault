/**
 * Double-entry accounting ledger backed by bun:sqlite.
 *
 * Convention: amount is signed.
 *   positive = credit (value flowing INTO the account)
 *   negative = debit  (value flowing OUT OF the account)
 *
 * Invariant: for each asset in a journal entry, SUM(amounts) == 0.
 *
 * Account naming:
 *   Assets:Wallet:{chainId}          — user holdings (debit-normal)
 *   Equity:Opening:{chainId}         — contra for reconciliation entries
 *   Income:Received:{chainId}        — incoming transfers
 *   Income:SwapIn:{chainId}          — swap destination side
 *   Expenses:Sent:{chainId}          — outgoing transfers
 *   Expenses:Fees:{chainId}          — gas / network fees
 *   Expenses:SwapOut:{chainId}       — swap source side
 */
import { getDb, getCachedBalances } from './db'
import { CHAINS } from '../shared/chains'
import type { ChainBalance } from '../shared/types'

export type AccountType = 'asset' | 'equity' | 'income' | 'expense'
export type EntryType = 'reconcile' | 'receive' | 'send' | 'swap' | 'fee' | 'opening' | 'manual'

export type LedgerPosting = {
  accountId: string
  accountType: AccountType
  asset: string
  chainId: string
  amount: number
}

export type LedgerSummaryEntry = {
  accountId: string
  accountType: string
  asset: string
  chainId: string
  balance: number
}

export type LedgerJournalEntry = {
  id: string
  deviceId: string
  txid?: string
  description: string
  entryType: string
  createdAt: number
  postings: Array<{ accountId: string; amount: number; asset: string }>
}

export type AccountStatement = {
  accountId: string
  accountType: string
  asset: string
  chainId: string
  openingBalance: number
  closingBalance: number
  postings: Array<{
    journalEntryId: string
    description: string
    entryType: string
    amount: number
    runningBalance: number
    createdAt: number
    txid?: string
  }>
}

export type SegmentRow = {
  period: string
  asset: string
  received: number
  sent: number
  swapIn: number
  swapOut: number
  fees: number
  reconciled: number
  net: number
}

export type MissingEntry = {
  kind: 'swap_not_recorded' | 'tx_not_recorded' | 'reconcile_gap' | 'balance_mismatch'
  description: string
  txid?: string
  asset?: string
  chainId?: string
  amount?: number
  detail?: string
}

export type AuditCheck = {
  name: string
  passed: boolean
  detail?: string
}

// ── Internal helpers ──────────────────────────────────────────────────

function ensureAccount(
  id: string,
  type: AccountType,
  asset: string,
  chainId: string,
  deviceId: string,
): void {
  const db = getDb()
  if (!db) return
  db.run(
    `INSERT OR IGNORE INTO ledger_accounts (id, type, device_id, asset, chain_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, type, deviceId, asset, chainId, Date.now()]
  )
}

function accountBalanceAt(accountId: string, asset: string, until?: number): number {
  const db = getDb()
  if (!db) return 0
  const q = until
    ? `SELECT COALESCE(SUM(p.amount), 0) AS bal FROM postings p JOIN journal_entries j ON j.id = p.journal_entry_id WHERE p.account_id = ? AND p.asset = ? AND j.created_at <= ?`
    : `SELECT COALESCE(SUM(amount), 0) AS bal FROM postings WHERE account_id = ? AND asset = ?`
  const row = (until ? db.query(q).get(accountId, asset, until) : db.query(q).get(accountId, asset)) as { bal: number } | null
  return row?.bal ?? 0
}

function periodLabel(ts: number, period: 'day' | 'week' | 'month'): string {
  const d = new Date(ts)
  if (period === 'day') return d.toISOString().slice(0, 10)
  if (period === 'month') return d.toISOString().slice(0, 7)
  // ISO week
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = tmp.getUTCDay() || 7
  tmp.setUTCDate(tmp.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

// ── Core write operations ─────────────────────────────────────────────

/**
 * Record an immutable journal entry. Per-asset sums must equal zero.
 * Returns the journal entry id or null if validation fails.
 */
export function recordJournalEntry(params: {
  deviceId: string
  txid?: string
  description: string
  entryType: EntryType
  postings: LedgerPosting[]
}): string | null {
  const db = getDb()
  if (!db) return null

  const assetTotals = new Map<string, number>()
  for (const p of params.postings) {
    assetTotals.set(p.asset, (assetTotals.get(p.asset) ?? 0) + p.amount)
  }
  for (const [asset, total] of assetTotals) {
    if (Math.abs(total) > 1e-9) {
      console.warn(`[ledger] Unbalanced entry for ${asset}: sum=${total}`, params.description)
      return null
    }
  }

  const id = crypto.randomUUID()
  const now = Date.now()

  db.transaction(() => {
    db.run(
      `INSERT INTO journal_entries (id, device_id, txid, description, entry_type, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, params.deviceId, params.txid ?? null, params.description, params.entryType, now]
    )
    for (const p of params.postings) {
      ensureAccount(p.accountId, p.accountType, p.asset, p.chainId, params.deviceId)
      db.run(
        `INSERT INTO postings (id, journal_entry_id, account_id, amount, asset, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), id, p.accountId, p.amount, p.asset, now]
      )
    }
  })()

  return id
}

const lastRectifyMs = new Map<string, number>()
const RECTIFY_INTERVAL_MS = 5 * 60 * 1000

export function rectifyWallet(deviceId: string, balances: ChainBalance[]): void {
  if (!getDb()) return
  const now = Date.now()
  if (now - (lastRectifyMs.get(deviceId) ?? 0) < RECTIFY_INTERVAL_MS) return
  lastRectifyMs.set(deviceId, now)
  for (const b of balances) {
    const current = parseFloat(b.balance) || 0
    if (!Number.isFinite(current)) continue

    const assetAccountId = `Assets:Wallet:${b.chainId}`
    const equityAccountId = `Equity:Opening:${b.chainId}`
    const ledgerBal = accountBalanceAt(assetAccountId, b.symbol)
    const diff = current - ledgerBal

    if (Math.abs(diff) < 1e-12) continue

    recordJournalEntry({
      deviceId,
      description: `Reconcile ${b.symbol} on ${b.chainId}`,
      entryType: 'reconcile',
      postings: [
        { accountId: assetAccountId, accountType: 'asset', asset: b.symbol, chainId: b.chainId, amount: diff },
        { accountId: equityAccountId, accountType: 'equity', asset: b.symbol, chainId: b.chainId, amount: -diff },
      ],
    })
  }
}

export function recordTransaction(params: {
  deviceId: string
  txid: string
  asset: string
  chainId: string
  amount: number
  activityType: 'send' | 'receive'
  fee?: number
}): void {
  const db = getDb()
  if (!db) return

  const exists = db.query(`SELECT 1 FROM journal_entries WHERE txid = ? AND device_id = ?`).get(params.txid, params.deviceId)
  if (exists) return

  const { deviceId, txid, asset, chainId, amount, activityType, fee } = params
  const assetAccountId = `Assets:Wallet:${chainId}`

  if (activityType === 'receive') {
    recordJournalEntry({
      deviceId, txid,
      description: `Receive ${amount} ${asset} — ${txid.slice(0, 12)}`,
      entryType: 'receive',
      postings: [
        { accountId: assetAccountId, accountType: 'asset', asset, chainId, amount },
        { accountId: `Income:Received:${chainId}`, accountType: 'income', asset, chainId, amount: -amount },
      ],
    })
    return
  }

  const feeAmt = fee ?? 0
  const postings: LedgerPosting[] = [
    { accountId: assetAccountId, accountType: 'asset', asset, chainId, amount: -(amount + feeAmt) },
    { accountId: `Expenses:Sent:${chainId}`, accountType: 'expense', asset, chainId, amount },
  ]
  if (feeAmt > 0) {
    postings.push({ accountId: `Expenses:Fees:${chainId}`, accountType: 'expense', asset, chainId, amount: feeAmt })
  }
  recordJournalEntry({ deviceId, txid, description: `Send ${amount} ${asset} — ${txid.slice(0, 12)}`, entryType: 'send', postings })
}

export function recordSwap(params: {
  deviceId: string
  txid: string
  fromAsset: string
  fromChainId: string
  fromAmount: number
  toAsset: string
  toChainId: string
  toAmount: number
}): void {
  const db = getDb()
  if (!db) return

  const exists = db.query(`SELECT 1 FROM journal_entries WHERE txid = ? AND device_id = ?`).get(params.txid, params.deviceId)
  if (exists) return

  const { deviceId, txid, fromAsset, fromChainId, fromAmount, toAsset, toChainId, toAmount } = params

  recordJournalEntry({
    deviceId, txid,
    description: `Swap ${fromAmount} ${fromAsset}→${toAsset} — ${txid.slice(0, 12)}`,
    entryType: 'swap',
    postings: [
      { accountId: `Assets:Wallet:${fromChainId}`, accountType: 'asset', asset: fromAsset, chainId: fromChainId, amount: -fromAmount },
      { accountId: `Expenses:SwapOut:${fromChainId}`, accountType: 'expense', asset: fromAsset, chainId: fromChainId, amount: fromAmount },
      { accountId: `Assets:Wallet:${toChainId}`, accountType: 'asset', asset: toAsset, chainId: toChainId, amount: toAmount },
      { accountId: `Income:SwapIn:${toChainId}`, accountType: 'income', asset: toAsset, chainId: toChainId, amount: -toAmount },
    ],
  })
}

// ── Read / audit operations ───────────────────────────────────────────

/** Trial balance: current balance per account. Pass `at` (epoch ms) for point-in-time. */
export function getTrialBalance(deviceId: string, at?: number): LedgerSummaryEntry[] {
  const db = getDb()
  if (!db) return []
  const q = at
    ? `SELECT p.account_id AS accountId, a.type AS accountType, p.asset, a.chain_id AS chainId,
         SUM(p.amount) AS balance
       FROM postings p
       JOIN journal_entries j ON j.id = p.journal_entry_id
       JOIN ledger_accounts a ON a.id = p.account_id
       WHERE a.device_id = ? AND j.created_at <= ?
       GROUP BY p.account_id, p.asset
       HAVING ABS(SUM(p.amount)) > 1e-12
       ORDER BY a.type, p.asset`
    : `SELECT p.account_id AS accountId, a.type AS accountType, p.asset, a.chain_id AS chainId,
         SUM(p.amount) AS balance
       FROM postings p
       JOIN ledger_accounts a ON a.id = p.account_id
       WHERE a.device_id = ?
       GROUP BY p.account_id, p.asset
       HAVING ABS(SUM(p.amount)) > 1e-12
       ORDER BY a.type, p.asset`
  return (at ? db.query(q).all(deviceId, at) : db.query(q).all(deviceId)) as LedgerSummaryEntry[]
}

// Alias kept for RPC compatibility
export function getLedgerSummary(deviceId: string): LedgerSummaryEntry[] {
  return getTrialBalance(deviceId)
}

/** Account statement with running balance. */
export function getAccountStatement(
  deviceId: string,
  accountId: string,
  since?: number,
  until?: number,
): AccountStatement | null {
  const db = getDb()
  if (!db) return null

  const acct = db.query(`SELECT id, type, asset, chain_id FROM ledger_accounts WHERE id = ? AND device_id = ?`)
    .get(accountId, deviceId) as { id: string; type: string; asset: string; chain_id: string } | null
  if (!acct) return null

  const openingBalance = since ? accountBalanceAt(accountId, acct.asset, since) : 0

  let sql = `SELECT p.id, p.journal_entry_id, p.amount, p.created_at,
               j.description, j.entry_type, j.txid
             FROM postings p
             JOIN journal_entries j ON j.id = p.journal_entry_id
             WHERE p.account_id = ? AND p.asset = ?`
  const args: any[] = [accountId, acct.asset]
  if (since) { sql += ` AND j.created_at >= ?`; args.push(since) }
  if (until) { sql += ` AND j.created_at <= ?`; args.push(until) }
  sql += ` ORDER BY j.created_at ASC`

  type Row = { id: string; journal_entry_id: string; amount: number; created_at: number; description: string; entry_type: string; txid: string | null }
  const rows = db.query(sql).all(...args) as Row[]

  let running = openingBalance
  const postingLines = rows.map(r => {
    running += r.amount
    return { journalEntryId: r.journal_entry_id, description: r.description, entryType: r.entry_type, amount: r.amount, runningBalance: running, createdAt: r.created_at, txid: r.txid ?? undefined }
  })

  return {
    accountId: acct.id,
    accountType: acct.type,
    asset: acct.asset,
    chainId: acct.chain_id,
    openingBalance,
    closingBalance: running,
    postings: postingLines,
  }
}

/** Paginated journal entries with embedded postings. */
export function getJournalFiltered(params: {
  deviceId: string
  since?: number
  until?: number
  entryType?: string
  asset?: string
  txid?: string
  q?: string
  limit?: number
  offset?: number
}): { entries: LedgerJournalEntry[]; total: number } {
  const db = getDb()
  if (!db) return { entries: [], total: 0 }

  const { deviceId, since, until, entryType, asset, txid, q, limit = 50, offset = 0 } = params
  const where: string[] = ['j.device_id = ?']
  const args: any[] = [deviceId]

  if (since) { where.push('j.created_at >= ?'); args.push(since) }
  if (until) { where.push('j.created_at <= ?'); args.push(until) }
  if (entryType) { where.push('j.entry_type = ?'); args.push(entryType) }
  if (txid) { where.push('j.txid = ?'); args.push(txid) }
  if (q) { where.push('j.description LIKE ?'); args.push(`%${q}%`) }
  if (asset) {
    where.push(`j.id IN (SELECT journal_entry_id FROM postings WHERE asset = ?)`)
    args.push(asset)
  }

  const whereClause = `WHERE ${where.join(' AND ')}`
  const countRow = db.query(`SELECT COUNT(*) AS c FROM journal_entries j ${whereClause}`).get(...args) as { c: number }
  const total = countRow?.c ?? 0

  type RawEntry = { id: string; device_id: string; txid: string | null; description: string; entry_type: string; created_at: number }
  const entries = db.query(
    `SELECT j.id, j.device_id, j.txid, j.description, j.entry_type, j.created_at
     FROM journal_entries j ${whereClause}
     ORDER BY j.created_at DESC
     LIMIT ? OFFSET ?`
  ).all(...args, limit, offset) as RawEntry[]

  const result = entries.map(e => {
    const postings = db.query(
      `SELECT account_id AS accountId, amount, asset FROM postings WHERE journal_entry_id = ?`
    ).all(e.id) as Array<{ accountId: string; amount: number; asset: string }>
    return { id: e.id, deviceId: e.device_id, txid: e.txid ?? undefined, description: e.description, entryType: e.entry_type, createdAt: e.created_at, postings }
  })

  return { entries: result, total }
}

/** Single journal entry with full postings. */
export function getJournalEntry(deviceId: string, entryId: string): LedgerJournalEntry | null {
  const db = getDb()
  if (!db) return null

  type RawEntry = { id: string; device_id: string; txid: string | null; description: string; entry_type: string; created_at: number }
  const e = db.query(`SELECT id, device_id, txid, description, entry_type, created_at FROM journal_entries WHERE id = ? AND device_id = ?`)
    .get(entryId, deviceId) as RawEntry | null
  if (!e) return null

  const postings = db.query(`SELECT account_id AS accountId, amount, asset FROM postings WHERE journal_entry_id = ?`)
    .all(e.id) as Array<{ accountId: string; amount: number; asset: string }>

  return { id: e.id, deviceId: e.device_id, txid: e.txid ?? undefined, description: e.description, entryType: e.entry_type, createdAt: e.created_at, postings }
}

/** Same as getLedgerJournals — kept for RPC compatibility. */
export function getLedgerJournals(deviceId: string, limit = 50): LedgerJournalEntry[] {
  return getJournalFiltered({ deviceId, limit }).entries
}

/** Create a named checkpoint snapshot of the current trial balance. */
export function createCheckpoint(deviceId: string, name: string): string {
  const db = getDb()
  if (!db) throw new Error('DB not available')
  const snapshot = getTrialBalance(deviceId)
  const id = crypto.randomUUID()
  db.run(
    `INSERT INTO ledger_checkpoints (id, device_id, name, snapshot, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, deviceId, name, JSON.stringify(snapshot), Date.now()]
  )
  return id
}

export function listCheckpoints(deviceId: string): Array<{ id: string; name: string; createdAt: number; accountCount: number }> {
  const db = getDb()
  if (!db) return []
  type Row = { id: string; name: string; created_at: number; snapshot: string }
  const rows = db.query(`SELECT id, name, created_at, snapshot FROM ledger_checkpoints WHERE device_id = ? ORDER BY created_at DESC`).all(deviceId) as Row[]
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    accountCount: (() => { try { return (JSON.parse(r.snapshot) as any[]).length } catch { return 0 } })(),
  }))
}

export function getCheckpoint(id: string, deviceId: string): {
  id: string; name: string; createdAt: number
  snapshot: LedgerSummaryEntry[]
  diff?: Array<{ accountId: string; asset: string; then: number; now: number; delta: number }>
} | null {
  const db = getDb()
  if (!db) return null
  type Row = { id: string; name: string; created_at: number; snapshot: string }
  const row = db.query(`SELECT id, name, created_at, snapshot FROM ledger_checkpoints WHERE id = ? AND device_id = ?`).get(id, deviceId) as Row | null
  if (!row) return null

  let snapshot: LedgerSummaryEntry[] = []
  try { snapshot = JSON.parse(row.snapshot) } catch {}

  const current = getTrialBalance(deviceId)
  const currentMap = new Map(current.map(e => [`${e.accountId}:${e.asset}`, e.balance]))

  const diff = snapshot.map(e => {
    const now = currentMap.get(`${e.accountId}:${e.asset}`) ?? 0
    return { accountId: e.accountId, asset: e.asset, then: e.balance, now, delta: now - e.balance }
  }).filter(d => Math.abs(d.delta) > 1e-12)

  // Also surface accounts that appeared after the checkpoint
  const snapshotKeys = new Set(snapshot.map(e => `${e.accountId}:${e.asset}`))
  for (const e of current) {
    const key = `${e.accountId}:${e.asset}`
    if (!snapshotKeys.has(key)) diff.push({ accountId: e.accountId, asset: e.asset, then: 0, now: e.balance, delta: e.balance })
  }

  return { id: row.id, name: row.name, createdAt: row.created_at, snapshot, diff }
}

/** Reconcile ledger Assets:Wallet:* vs cached on-chain balances. */
export function reconcileLedger(deviceId: string): Array<{
  chainId: string; asset: string; ledgerBalance: number; cachedBalance: number; diff: number; inSync: boolean
}> {
  const db = getDb()
  if (!db) return []

  const cached = getCachedBalances(deviceId)
  const results: ReturnType<typeof reconcileLedger> = []

  for (const b of (cached?.balances ?? [])) {
    const ledgerBal = accountBalanceAt(`Assets:Wallet:${b.chainId}`, b.symbol)
    const cachedBal = parseFloat(b.balance) || 0
    const diff = cachedBal - ledgerBal
    results.push({ chainId: b.chainId, asset: b.symbol, ledgerBalance: ledgerBal, cachedBalance: cachedBal, diff, inSync: Math.abs(diff) < 1e-8 })
  }
  return results.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
}

/** Net flows grouped by time period. */
export function getSegment(
  deviceId: string,
  period: 'day' | 'week' | 'month',
  since?: number,
  until?: number,
  asset?: string,
): SegmentRow[] {
  const db = getDb()
  if (!db) return []

  let sql = `SELECT j.entry_type, j.created_at, p.asset, p.account_id, p.amount
             FROM postings p
             JOIN journal_entries j ON j.id = p.journal_entry_id
             JOIN ledger_accounts a ON a.id = p.account_id
             WHERE j.device_id = ? AND a.type IN ('asset','income','expense')`
  const args: any[] = [deviceId]
  if (since) { sql += ` AND j.created_at >= ?`; args.push(since) }
  if (until) { sql += ` AND j.created_at <= ?`; args.push(until) }
  if (asset) { sql += ` AND p.asset = ?`; args.push(asset) }

  type Row = { entry_type: string; created_at: number; asset: string; account_id: string; amount: number }
  const rows = db.query(sql).all(...args) as Row[]

  const buckets = new Map<string, SegmentRow>()
  for (const r of rows) {
    const key = `${periodLabel(r.created_at, period)}::${r.asset}`
    if (!buckets.has(key)) buckets.set(key, { period: periodLabel(r.created_at, period), asset: r.asset, received: 0, sent: 0, swapIn: 0, swapOut: 0, fees: 0, reconciled: 0, net: 0 })
    const b = buckets.get(key)!
    const amt = Math.abs(r.amount)
    switch (r.entry_type) {
      case 'receive':
        if (r.account_id.startsWith('Assets:Wallet')) b.received += amt
        break
      case 'send':
        if (r.account_id.startsWith('Expenses:Sent')) b.sent += amt
        if (r.account_id.startsWith('Expenses:Fees')) b.fees += amt
        break
      case 'swap':
        if (r.account_id.startsWith('Income:SwapIn')) b.swapIn += amt
        if (r.account_id.startsWith('Expenses:SwapOut')) b.swapOut += amt
        break
      case 'reconcile':
        if (r.account_id.startsWith('Assets:Wallet')) b.reconciled += r.amount
        break
    }
  }

  for (const b of buckets.values()) {
    b.net = b.received + b.swapIn - b.sent - b.swapOut - b.fees
  }

  return [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period) || a.asset.localeCompare(b.asset))
}

/** Find transactions and swaps that should be in the ledger but aren't. */
export function getMissingEntries(deviceId: string): MissingEntry[] {
  const db = getDb()
  if (!db) return []
  const missing: MissingEntry[] = []

  // 1. Completed swaps with no ledger entry
  type SwapRow = { txid: string; from_symbol: string; to_symbol: string; from_chain_id: string; to_chain_id: string; from_amount: string; received_output: string | null; completed_at: number | null }
  const completedSwaps = db.query(
    `SELECT txid, from_symbol, to_symbol, from_chain_id, to_chain_id, from_amount, received_output, completed_at
     FROM swap_history WHERE device_id = ? AND status = 'completed'`
  ).all(deviceId) as SwapRow[]

  const recordedSwapTxids = new Set<string>(
    (db.query(`SELECT txid FROM journal_entries WHERE device_id = ? AND entry_type = 'swap' AND txid IS NOT NULL`).all(deviceId) as { txid: string }[]).map(r => r.txid)
  )

  for (const s of completedSwaps) {
    if (!recordedSwapTxids.has(s.txid)) {
      missing.push({
        kind: 'swap_not_recorded',
        description: `Completed swap ${s.from_symbol}→${s.to_symbol} not in ledger`,
        txid: s.txid,
        asset: s.from_symbol,
        chainId: s.from_chain_id,
        amount: parseFloat(s.from_amount) || 0,
        detail: `Completed at ${s.completed_at ? new Date(s.completed_at).toISOString() : 'unknown'}, output=${s.received_output ?? '?'}`,
      })
    }
  }

  // 2. On-chain scanned txids with no ledger entry
  type ScanRow = { txid: string; activity_type: string; chain: string | null; response_body: string | null }
  const scannedTxs = db.query(
    `SELECT txid, activity_type, chain, response_body FROM api_log
     WHERE device_id = ? AND method = 'SCAN' AND txid IS NOT NULL AND activity_type IN ('send','receive')`
  ).all(deviceId) as ScanRow[]

  const recordedTxTxids = new Set<string>(
    (db.query(`SELECT txid FROM journal_entries WHERE device_id = ? AND entry_type IN ('send','receive') AND txid IS NOT NULL`).all(deviceId) as { txid: string }[]).map(r => r.txid)
  )

  for (const t of scannedTxs) {
    if (!recordedTxTxids.has(t.txid!)) {
      let amount: number | undefined
      let chainId = t.chain ?? undefined
      try { const m = JSON.parse(t.response_body ?? '{}'); amount = parseFloat(m.value); chainId = m.chainId ?? chainId } catch {}
      missing.push({
        kind: 'tx_not_recorded',
        description: `On-chain ${t.activity_type} tx not in ledger`,
        txid: t.txid ?? undefined,
        chainId,
        amount,
        detail: `activity_type=${t.activity_type}`,
      })
    }
  }

  // 3. Large reconciliation entries (unexplained jumps > 1% of current balance OR > $100 equivalent)
  type RecRow = { id: string; description: string; created_at: number }
  const reconcileEntries = db.query(
    `SELECT j.id, j.description, j.created_at FROM journal_entries j
     WHERE j.device_id = ? AND j.entry_type = 'reconcile'`
  ).all(deviceId) as RecRow[]

  for (const e of reconcileEntries) {
    const postings = db.query(`SELECT account_id, amount, asset FROM postings WHERE journal_entry_id = ?`).all(e.id) as Array<{ account_id: string; amount: number; asset: string }>
    for (const p of postings) {
      if (p.account_id.startsWith('Assets:Wallet') && Math.abs(p.amount) > 0.001) {
        missing.push({
          kind: 'reconcile_gap',
          description: `Large reconciliation adjustment: ${p.amount > 0 ? '+' : ''}${p.amount.toFixed(8)} ${p.asset}`,
          asset: p.asset,
          amount: p.amount,
          detail: `Journal entry ${e.id} at ${new Date(e.created_at).toISOString()}. This means the ledger balance didn't match on-chain and was force-corrected. Check for unrecorded transactions before this date.`,
        })
      }
    }
  }

  // 4. Current balance mismatches
  const reconcile = reconcileLedger(deviceId)
  for (const r of reconcile) {
    if (!r.inSync && Math.abs(r.diff) > 1e-8) {
      missing.push({
        kind: 'balance_mismatch',
        description: `Current ledger/chain mismatch for ${r.asset} on ${r.chainId}`,
        asset: r.asset,
        chainId: r.chainId,
        amount: r.diff,
        detail: `Ledger=${r.ledgerBalance.toFixed(8)}, on-chain=${r.cachedBalance.toFixed(8)}, diff=${r.diff > 0 ? '+' : ''}${r.diff.toFixed(8)}`,
      })
    }
  }

  return missing
}

/** Integrity audit: verify all entries balance, no orphans, etc. */
export function auditLedger(deviceId: string): { passed: boolean; checks: AuditCheck[] } {
  const db = getDb()
  if (!db) return { passed: false, checks: [{ name: 'db_available', passed: false }] }

  const checks: AuditCheck[] = []

  // Check 1: every journal entry balances per asset
  type EntryRow = { id: string; description: string; created_at: number }
  const allEntries = db.query(`SELECT id, description, created_at FROM journal_entries WHERE device_id = ?`).all(deviceId) as EntryRow[]
  let unbalancedCount = 0
  const unbalancedExamples: string[] = []
  for (const e of allEntries) {
    const totals = new Map<string, number>()
    const postings = db.query(`SELECT asset, amount FROM postings WHERE journal_entry_id = ?`).all(e.id) as Array<{ asset: string; amount: number }>
    for (const p of postings) totals.set(p.asset, (totals.get(p.asset) ?? 0) + p.amount)
    for (const [asset, total] of totals) {
      if (Math.abs(total) > 1e-9) {
        unbalancedCount++
        if (unbalancedExamples.length < 3) unbalancedExamples.push(`entry ${e.id.slice(0, 8)} asset=${asset} sum=${total.toFixed(12)}`)
      }
    }
  }
  checks.push({ name: 'all_entries_balance', passed: unbalancedCount === 0, detail: unbalancedCount === 0 ? `${allEntries.length} entries checked` : `${unbalancedCount} unbalanced: ${unbalancedExamples.join('; ')}` })

  // Check 2: no orphaned postings
  const orphanCount = (db.query(`SELECT COUNT(*) AS c FROM postings p WHERE NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.id = p.journal_entry_id AND j.device_id = ?)`).get(deviceId) as { c: number }).c
  checks.push({ name: 'no_orphan_postings', passed: orphanCount === 0, detail: `${orphanCount} orphaned postings` })

  // Check 3: all postings reference known accounts
  const orphanAcctCount = (db.query(`SELECT COUNT(*) AS c FROM postings p JOIN journal_entries j ON j.id = p.journal_entry_id WHERE j.device_id = ? AND NOT EXISTS (SELECT 1 FROM ledger_accounts a WHERE a.id = p.account_id)`).get(deviceId) as { c: number }).c
  checks.push({ name: 'all_postings_have_accounts', passed: orphanAcctCount === 0, detail: `${orphanAcctCount} postings with unknown account` })

  // Check 4: no duplicate txids for send/receive
  const dupRows = db.query(
    `SELECT txid, COUNT(*) AS c FROM journal_entries WHERE device_id = ? AND entry_type IN ('send','receive') AND txid IS NOT NULL GROUP BY txid HAVING c > 1`
  ).all(deviceId) as Array<{ txid: string; c: number }>
  checks.push({ name: 'no_duplicate_txids', passed: dupRows.length === 0, detail: dupRows.length === 0 ? 'OK' : `Duplicate txids: ${dupRows.map(r => r.txid.slice(0, 12)).join(', ')}` })

  // Check 5: ledger vs cached balance
  const reconcile = reconcileLedger(deviceId)
  const outOfSync = reconcile.filter(r => !r.inSync)
  checks.push({ name: 'ledger_matches_chain', passed: outOfSync.length === 0, detail: outOfSync.length === 0 ? `${reconcile.length} chains in sync` : outOfSync.map(r => `${r.asset}(${r.chainId}) diff=${r.diff.toFixed(8)}`).join('; ') })

  // Check 6: timestamps monotonically non-decreasing (sanity)
  const timeRows = db.query(`SELECT created_at FROM journal_entries WHERE device_id = ? ORDER BY rowid ASC`).all(deviceId) as Array<{ created_at: number }>
  let timeViolations = 0
  for (let i = 1; i < timeRows.length; i++) {
    if (timeRows[i].created_at < timeRows[i - 1].created_at - 1000) timeViolations++
  }
  checks.push({ name: 'timestamps_sane', passed: timeViolations === 0, detail: `${timeViolations} out-of-order timestamps` })

  return { passed: checks.every(c => c.passed), checks }
}

/** Replay: re-derive all ledger entries from swap_history + api_log for a device. */
// Lazy map: short chainId → base decimals (e.g. bitcoin→8, ethereum→18, solana→9)
// Built from CHAINS which derives decimals from @pioneer-platform/pioneer-caip BaseDecimal.
let _chainDecimals: Map<string, number> | null = null
function getChainDecimals(): Map<string, number> {
  if (_chainDecimals) return _chainDecimals
  _chainDecimals = new Map()
  for (const c of CHAINS) {
    if (c.decimals != null) _chainDecimals.set(c.id, c.decimals)
  }
  return _chainDecimals
}

function normalizeAmount(raw: number, chainId: string): number {
  const decimals = getChainDecimals().get(chainId)
  if (decimals == null) return raw
  return raw / Math.pow(10, decimals)
}

export function replayLedger(deviceId: string): {
  cleared: number
  swapsReplayed: number
  txsReplayed: number
  skipped: number
  reconcileEntries: number
  durationMs: number
} {
  const db = getDb()
  if (!db) throw new Error('DB not available')
  const t0 = Date.now()

  // Count before clearing
  const entryCount = (db.query(`SELECT COUNT(*) AS c FROM journal_entries WHERE device_id = ?`).get(deviceId) as { c: number }).c

  // Clear all ledger data for this device
  db.transaction(() => {
    const entryIds = (db.query(`SELECT id FROM journal_entries WHERE device_id = ?`).all(deviceId) as { id: string }[]).map(r => r.id)
    for (const id of entryIds) db.run(`DELETE FROM postings WHERE journal_entry_id = ?`, [id])
    db.run(`DELETE FROM journal_entries WHERE device_id = ?`, [deviceId])
    db.run(`DELETE FROM ledger_accounts WHERE device_id = ?`, [deviceId])
  })()

  let swapsReplayed = 0
  let txsReplayed = 0
  let skipped = 0

  // Re-record completed swaps (amounts already in display units in swap_history)
  type SwapRow = { txid: string; from_symbol: string; from_chain_id: string; from_amount: string; to_symbol: string; to_chain_id: string; received_output: string | null; quoted_output: string }
  const swaps = db.query(
    `SELECT txid, from_symbol, from_chain_id, from_amount, to_symbol, to_chain_id, received_output, quoted_output
     FROM swap_history WHERE device_id = ? AND status = 'completed' ORDER BY created_at ASC`
  ).all(deviceId) as SwapRow[]

  for (const s of swaps) {
    recordSwap({
      deviceId,
      txid: s.txid,
      fromAsset: s.from_symbol,
      fromChainId: s.from_chain_id,
      fromAmount: parseFloat(s.from_amount) || 0,
      toAsset: s.to_symbol,
      toChainId: s.to_chain_id,
      toAmount: parseFloat(s.received_output || s.quoted_output) || 0,
    })
    swapsReplayed++
  }

  // Re-record scanned on-chain transactions from api_log.
  // Pioneer returns amounts in base units (wei for EVM, satoshis for BTC, lamports for SOL).
  // Normalize to display units via CHAIN_DECIMALS before recording.
  type ScanRow = { txid: string; activity_type: string; chain: string | null; response_body: string | null; timestamp: number }
  const scans = db.query(
    `SELECT txid, activity_type, chain, response_body, timestamp FROM api_log
     WHERE device_id = ? AND txid IS NOT NULL AND activity_type IN ('send','receive')
     ORDER BY timestamp ASC`
  ).all(deviceId) as ScanRow[]

  // Swap txids already recorded above — skip them to avoid double-counting
  const swapTxids = new Set(swaps.map(s => s.txid))

  for (const t of scans) {
    if (swapTxids.has(t.txid!)) { skipped++; continue }

    let meta: any = {}
    try { meta = JSON.parse(t.response_body ?? '{}') } catch {}

    const chainId = meta.chainId ?? t.chain ?? 'unknown'
    const asset = meta.chainSymbol ?? t.chain ?? 'UNKNOWN'
    const rawAmount = Math.abs(parseFloat(meta.value ?? '0') || 0)
    if (rawAmount <= 0) { skipped++; continue }

    // Convert base units → display units. If no decimals mapping exists, skip
    // rather than record a wildly wrong amount.
    const decimals = getChainDecimals().get(chainId)
    if (decimals == null) { skipped++; continue }
    const amount = normalizeAmount(rawAmount, chainId)
    if (amount <= 0) { skipped++; continue }

    recordTransaction({ deviceId, txid: t.txid!, asset, chainId, amount, activityType: t.activity_type as 'send' | 'receive' })
    txsReplayed++
  }

  // Pass 1: rectify all chains that have a positive cached balance.
  const cached = getCachedBalances(deviceId)
  let reconcileEntries = 0
  if (cached?.balances.length) {
    const before = (db.query(`SELECT COUNT(*) AS c FROM journal_entries WHERE device_id = ?`).get(deviceId) as { c: number }).c
    rectifyWallet(deviceId, cached.balances)
    const after = (db.query(`SELECT COUNT(*) AS c FROM journal_entries WHERE device_id = ?`).get(deviceId) as { c: number }).c
    reconcileEntries = after - before
  }

  // Pass 2: reconcile any ledger asset accounts that still have a non-zero balance
  // but are NOT in the cached balances list (on-chain = 0, e.g. TRX fully swapped out
  // before tracking started, BCH residual from an old swap).
  const cachedMap = new Map<string, number>()
  for (const b of (cached?.balances ?? [])) {
    cachedMap.set(`${b.chainId}:${b.symbol}`, parseFloat(b.balance) || 0)
  }

  type LedgerAcct = { id: string; asset: string; chain_id: string; balance: number }
  const nonZeroAccounts = db.query(
    `SELECT a.id, a.asset, a.chain_id, COALESCE(SUM(p.amount), 0) AS balance
     FROM ledger_accounts a
     LEFT JOIN postings p ON p.account_id = a.id
     WHERE a.device_id = ? AND a.type = 'asset'
     GROUP BY a.id
     HAVING ABS(COALESCE(SUM(p.amount), 0)) > 1e-12`
  ).all(deviceId) as LedgerAcct[]

  for (const acct of nonZeroAccounts) {
    const onChain = cachedMap.get(`${acct.chain_id}:${acct.asset}`) ?? 0
    const diff = onChain - acct.balance
    if (Math.abs(diff) < 1e-12) continue
    const id = recordJournalEntry({
      deviceId,
      description: `Reconcile ${acct.asset} on ${acct.chain_id}`,
      entryType: 'reconcile',
      postings: [
        { accountId: acct.id, accountType: 'asset', asset: acct.asset, chainId: acct.chain_id, amount: diff },
        { accountId: `Equity:Opening:${acct.chain_id}`, accountType: 'equity', asset: acct.asset, chainId: acct.chain_id, amount: -diff },
      ],
    })
    if (id) reconcileEntries++
  }

  return { cleared: entryCount, swapsReplayed, txsReplayed, skipped, reconcileEntries, durationMs: Date.now() - t0 }
}

/** CSV export of all journal entries with postings. */
export function exportLedgerCsv(deviceId: string): string {
  const db = getDb()
  if (!db) return ''

  const lines: string[] = ['date,journal_entry_id,txid,entry_type,description,account_id,account_type,asset,amount']

  type Row = { id: string; txid: string | null; entry_type: string; description: string; created_at: number; accountId: string; accountType: string; asset: string; amount: number }
  const rows = db.query(`
    SELECT j.id, j.txid, j.entry_type, j.description, j.created_at,
           p.account_id AS accountId, a.type AS accountType, p.asset, p.amount
    FROM journal_entries j
    JOIN postings p ON p.journal_entry_id = j.id
    JOIN ledger_accounts a ON a.id = p.account_id
    WHERE j.device_id = ?
    ORDER BY j.created_at ASC, j.id, p.rowid
  `).all(deviceId) as Row[]

  for (const r of rows) {
    const date = new Date(r.created_at).toISOString()
    const csvRow = [date, r.id, r.txid ?? '', r.entry_type, `"${r.description.replace(/"/g, '""')}"`, r.accountId, r.accountType, r.asset, r.amount.toFixed(12)].join(',')
    lines.push(csvRow)
  }

  return lines.join('\n')
}

/** Insert a manual correction entry. */
export function insertManualEntry(params: {
  deviceId: string
  description: string
  postings: LedgerPosting[]
}): string | null {
  return recordJournalEntry({ ...params, entryType: 'manual' })
}
