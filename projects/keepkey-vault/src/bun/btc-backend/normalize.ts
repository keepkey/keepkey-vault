/**
 * Pure Pioneer-response normalizers — no imports, no side effects, so they're
 * unit-testable without dragging in the electrobun/pioneer module chain.
 */
import type { BtcUtxo, BtcFeeRates } from './types'

/** Pioneer historically returns application failures as successful HTTP
 * responses. Never let a money-path adapter reinterpret one as empty data. */
export function assertPioneerSuccess(resp: any, operation: string): any {
  for (const layer of [resp, resp?.data, resp?.data?.data]) {
    if (layer && typeof layer === 'object' && layer.success === false) {
      const reason = typeof layer.error === 'string' ? layer.error : 'Pioneer reported failure'
      throw new Error(`${operation} failed: ${reason}`)
    }
  }
  return resp
}

/** Pioneer ListUnspent double-wraps (Swagger + Axios). Peel to the array. */
export function unwrapUtxos(resp: any): any[] {
  const utxos = Array.isArray(resp) ? resp
    : Array.isArray(resp?.data) ? resp.data
    : Array.isArray(resp?.data?.data) ? resp.data.data
    : Array.isArray(resp?.utxos) ? resp.utxos
    : undefined
  if (!utxos) throw new Error('ListUnspent failed: malformed Pioneer response')
  return utxos
}

export function normalizeUtxo(u: any): BtcUtxo {
  const value = Number(u?.value)
  if (typeof u?.txid !== 'string' || u.txid.length === 0) {
    throw new Error('ListUnspent failed: UTXO omitted txid')
  }
  if (!Number.isSafeInteger(u?.vout) || u.vout < 0) {
    throw new Error(`ListUnspent failed: invalid vout for ${u.txid}`)
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`ListUnspent failed: invalid satoshi value for ${u.txid}:${u.vout}`)
  }
  return {
    txid: u.txid,
    vout: u.vout,
    value,
    hex: u.tx?.hex || u.hex || undefined,
    scriptType: u.scriptType || undefined,
    path: u.path || undefined,
    address: u.address || u.addr || undefined,
  }
}

/** Pioneer fee response → sat/vByte. Auto-detects legacy sat/kB responses
 * (values >500) until Pioneer exposes an explicit unit field. */
export function normalizeFeeRates(resp: any): BtcFeeRates {
  const d = resp?.data || resp || {}
  const fast = d.fastest ?? d.fast
  const vals = [d.slow, d.average, fast].filter(
    (v: any): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0,
  )
  if (vals.length === 0) throw new Error('GetFeeRate failed: Pioneer returned no valid fee rates')
  const perKb = vals.some((v) => v > 500)
  const fallback = vals[0]
  const conv = (v: number | undefined) =>
    Math.max(1, Math.ceil((typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback) / (perKb ? 1000 : 1)))
  return {
    slow: conv(d.slow ?? d.average),
    average: conv(d.average ?? fast),
    fast: conv(fast ?? d.average),
  }
}

export function extractTxid(resp: any): string | undefined {
  const d = resp?.data || resp
  return d?.txid || d?.tx_hash || d?.hash || undefined
}

/** Axios adds one data layer and LookupUtxoTx adds another. */
export function extractRawTxHex(resp: any): string | undefined {
  const candidates = [
    resp?.data?.data?.hex,
    resp?.data?.hex,
    resp?.data?.tx?.hex,
    resp?.hex,
    resp?.tx?.hex,
  ]
  return candidates.find((value): value is string => typeof value === 'string' && value.length > 0)
}
