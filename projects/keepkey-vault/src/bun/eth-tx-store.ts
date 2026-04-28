/**
 * eth-tx-store.ts — passive store + Pioneer-backed enrichment for plain
 * ETH transactions.
 *
 * Vault is *not* a polling source. It registers each tx at sign time,
 * stores the row in eth_tx_status, and only refreshes status when a
 * client (BEX, SDK) actually asks via GET /api/v1/tx/...
 *
 * Refresh is exclusively through Pioneer's LookupTx — never a direct
 * RPC call (HARD rule, see memory feedback_rest_route_shape.md and the
 * Pioneer-only-broadcast convention).
 */
import { ethers } from 'ethers'
import type { PendingEthTx, EthTxStatus, EthTxStatusRow } from '../shared/types'
import {
  insertEthTxStatus, updateEthTxStatus,
  getEthTxStatus, getOpenEthTxStatuses, getEthRawTxByTxid,
} from './db'
import { getPioneer } from './pioneer'

const TAG = '[eth-tx-store]'

const TERMINAL: ReadonlySet<EthTxStatus> = new Set(['confirmed', 'failed', 'dropped'])

/** keccak256 of the raw signed bytes — the canonical Ethereum txid. */
export function computeTxid(serializedHex: string): string {
  const hex = serializedHex.startsWith('0x') ? serializedHex : `0x${serializedHex}`
  return ethers.utils.keccak256(hex).toLowerCase()
}

export interface RegisterArgs {
  serialized: string                          // 0x-prefixed signed bytes
  networkId: string                           // 'eip155:1'
  chainId: number                             // 1
  from: string
  to: string
  valueWei?: string
  nonce: number
  origin?: string
  appName?: string
  label?: string
}

/**
 * Persist a freshly-signed tx. Idempotent on (txid). Called from the
 * `/eth/sign-transaction` REST handler immediately after the device
 * returns a serialized blob.
 *
 * Returns the txid so the caller can include it in the response if it
 * wants. Never throws — DB failures are logged but don't break signing.
 */
export function registerSignedTx(args: RegisterArgs): string | null {
  let txid: string
  try {
    txid = computeTxid(args.serialized)
  } catch (e: any) {
    console.warn(`${TAG} failed to compute txid from serialized: ${e.message}`)
    return null
  }
  const now = Date.now()
  const row: EthTxStatusRow = {
    txid,
    networkId: args.networkId,
    chainId: args.chainId,
    from: (args.from || '').toLowerCase(),
    to: (args.to || '').toLowerCase(),
    valueWei: args.valueWei || '0x0',
    nonce: args.nonce,
    status: 'broadcast',
    attempts: 0,
    confirmations: 0,
    broadcastAtMs: now,
    lastCheckMs: now,
    origin: args.origin,
    appName: args.appName,
    label: args.label,
  }
  insertEthTxStatus(row)
  return txid
}

/**
 * Pioneer-backed status lookup. Wraps `pioneer.LookupTx({networkId, txid})`.
 *
 * Pioneer's LookupTx returns transaction details and receipt. We map
 * its loosely-typed response onto our PendingEthTx-status fields. If
 * Pioneer returns an error or the tx isn't on-chain yet, we surface a
 * "still pending" state to the caller — the row's stored status governs
 * what we return when we can't enrich.
 */
async function lookupTxOnPioneer(networkId: string, txid: string): Promise<{
  status: EthTxStatus | null
  blockNumber?: number
  confirmations?: number
  gasUsed?: string
  effectiveGasPrice?: string
  errorReason?: string
}> {
  try {
    const pioneer = await getPioneer()
    if (typeof pioneer.LookupTx !== 'function') {
      console.warn(`${TAG} Pioneer SDK missing LookupTx method`)
      return { status: null }
    }
    const resp = await pioneer.LookupTx({ networkId, txid })
    const data = resp?.data || resp
    if (!data || data.error || data.status === 'not_found') return { status: null }

    // Pioneer's response shape isn't tightly versioned; defensively pull
    // the fields we know about and normalise to our enum.
    const blockNumber = parseIntOrUndef(data.blockNumber ?? data.receipt?.blockNumber)
    const onChainStatus = data.status ?? data.receipt?.status
    const confirmations = parseIntOrUndef(data.confirmations)
    const gasUsed = data.gasUsed ?? data.receipt?.gasUsed
    const effectiveGasPrice = data.effectiveGasPrice ?? data.receipt?.effectiveGasPrice

    let mapped: EthTxStatus | null = null
    if (blockNumber !== undefined) {
      const ok = onChainStatus === '0x1' || onChainStatus === 1 || onChainStatus === true
        || onChainStatus === 'success' || onChainStatus === 'confirmed'
      mapped = ok ? 'confirmed' : 'failed'
    } else if (data.pending === true || onChainStatus === 'pending' || data.mempool === true) {
      mapped = 'pending'
    }

    return {
      status: mapped,
      blockNumber,
      confirmations,
      gasUsed: gasUsed != null ? String(gasUsed) : undefined,
      effectiveGasPrice: effectiveGasPrice != null ? String(effectiveGasPrice) : undefined,
      errorReason: mapped === 'failed' ? (data.errorReason || data.error?.message || 'execution reverted') : undefined,
    }
  } catch (e: any) {
    console.warn(`${TAG} Pioneer LookupTx failed for ${networkId}/${txid.slice(0, 12)}…: ${e.message}`)
    return { status: null }
  }
}

function parseIntOrUndef(v: any): number | undefined {
  if (v == null) return undefined
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = v.startsWith('0x') ? parseInt(v, 16) : parseInt(v, 10)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/**
 * Refresh a row's status via Pioneer and persist any state changes.
 * No-op for txs already in a terminal state (the chain authority has
 * already spoken).
 */
export async function refreshTxStatus(row: EthTxStatusRow): Promise<EthTxStatusRow> {
  if (TERMINAL.has(row.status)) return row
  const result = await lookupTxOnPioneer(row.networkId, row.txid)
  const patch: Partial<Omit<EthTxStatusRow, 'txid'>> = {
    attempts: row.attempts + 1,
    lastCheckMs: Date.now(),
  }
  if (result.status && result.status !== row.status) patch.status = result.status
  if (result.blockNumber !== undefined) patch.blockNumber = result.blockNumber
  if (result.confirmations !== undefined) patch.confirmations = result.confirmations
  if (result.gasUsed !== undefined) patch.gasUsed = result.gasUsed
  if (result.effectiveGasPrice !== undefined) patch.effectiveGasPrice = result.effectiveGasPrice
  if (result.errorReason) patch.errorReason = result.errorReason
  updateEthTxStatus(row.txid, patch)
  return { ...row, ...patch }
}

/** Project a row + optional raw hex into the wire shape returned over REST. */
export function rowToWire(row: EthTxStatusRow, rawHex?: string | null): PendingEthTx {
  return {
    txid: row.txid,
    networkId: row.networkId,
    chainId: row.chainId,
    from: row.from,
    to: row.to,
    valueWei: row.valueWei,
    nonce: row.nonce,
    status: row.status,
    attempts: row.attempts,
    confirmations: row.confirmations,
    blockNumber: row.blockNumber,
    gasUsed: row.gasUsed,
    effectiveGasPrice: row.effectiveGasPrice,
    errorReason: row.errorReason,
    broadcastAtMs: row.broadcastAtMs,
    lastCheckMs: row.lastCheckMs,
    terminalAtMs: row.terminalAtMs,
    origin: row.origin,
    appName: row.appName,
    label: row.label,
    ...(rawHex ? { rawHex } : {}),
  }
}

// ── Read APIs used by REST handlers ─────────────────────────────────

/** All open (non-terminal) txs, optionally filtered by networkId / from address. */
export async function listOpenTxs(filter?: { networkId?: string; from?: string; refresh?: boolean }): Promise<PendingEthTx[]> {
  const rows = getOpenEthTxStatuses({ networkId: filter?.networkId, from: filter?.from, limit: 100 })
  if (!filter?.refresh) return rows.map(r => rowToWire(r))
  // Refresh each via Pioneer in parallel — bounded by listOpenTxs limit (100 max)
  const enriched = await Promise.all(rows.map(r => refreshTxStatus(r).catch(() => r)))
  return enriched.map(r => rowToWire(r))
}

/** Get a single tx by txid. Includes raw hex from api_log if available. */
export async function getOneTx(txid: string, opts?: { refresh?: boolean }): Promise<PendingEthTx | null> {
  let row = getEthTxStatus(txid)
  if (!row) return null
  if (opts?.refresh) {
    try { row = await refreshTxStatus(row) } catch { /* keep stored row on failure */ }
  }
  const rawHex = getEthRawTxByTxid(row.txid)
  return rowToWire(row, rawHex)
}
