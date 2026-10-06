import { createHash } from 'node:crypto'

import type { ClearSignObservation, ClearSignObservationOutcome } from '../shared/types'
import { observeEvmCall, observeMalformedSolanaTransaction, observeSolanaTransaction, summarizeClearSignObservations } from './clearsign-observation'

export interface LegacyClearSignRow {
  id: number
  timestamp: number
  route: string
  status: number
  requestBody?: string
}

function outcome(status: number): Exclude<ClearSignObservationOutcome, 'pending'> {
  if (status >= 200 && status < 300) return 'signed'
  if (status === 408 || status === 504) return 'timed-out'
  if (status === 401 || status === 403) return 'policy-blocked'
  // Historic HTTP logs did not preserve approval-dialog disposition. Do not
  // mislabel every 4xx as a user rejection.
  return 'failed'
}

/** Replay legacy rows transiently; returned shapes never contain arguments or accounts. */
export function replayLegacyClearSignRows(rows: LegacyClearSignRow[]) {
  const observations: ClearSignObservation[] = []
  const skippedByReason: Record<string, number> = {}
  const skip = (reason: string) => { skippedByReason[reason] = (skippedByReason[reason] || 0) + 1 }
  for (const row of rows) {
    let body: any
    try { body = JSON.parse(row.requestBody || '{}') } catch { skip('invalid-json'); continue }
    let draft
    try {
      if (row.route === '/eth/sign-transaction') {
        const chainId = Number(body.chainId ?? body.chain_id)
        if (!Number.isSafeInteger(chainId) || chainId < 1) { skip('invalid-evm-context'); continue }
        draft = observeEvmCall({ chainId, to: body.to, data: body.data || '0x', hostDecoded: false })
      } else if (row.route === '/solana/sign-transaction') {
        const rawTxBase64 = String(body.raw_tx || body.rawTx || body.transactionBase64 || '')
        if (!rawTxBase64) { skip('missing-solana-transaction'); continue }
        try { draft = observeSolanaTransaction({ rawTxBase64, hostDecoded: true }) }
        catch { draft = observeMalformedSolanaTransaction(rawTxBase64) }
      } else { skip('unsupported-route'); continue }
    } catch { skip('classification-failed'); continue }
    observations.push({
      ...draft,
      id: `legacy:${createHash('sha256').update(`${row.id}:${row.timestamp}:${row.route}`).digest('hex').slice(0, 24)}`,
      createdAt: row.timestamp, finalizedAt: row.timestamp, source: 'rest-api', outcome: outcome(row.status),
    })
  }
  return {
    version: 1 as const,
    mode: 'read-only-transient-replay' as const,
    sourceRows: rows.length,
    classifiedRows: observations.length,
    skippedByReason,
    coverage: summarizeClearSignObservations(observations, rows.reduce((max, row) => Math.max(max, row.timestamp), 0)),
    limitations: [
      'Legacy HTTP logs record completed requests, not every approval prompt; missing attempts cannot be reconstructed.',
      'Historic non-success HTTP statuses do not reliably distinguish user rejection from validation or transport failure.',
      'Replay applies the current privacy-safe classifier and does not claim the protection UI or simulation ran historically.',
    ],
  }
}
