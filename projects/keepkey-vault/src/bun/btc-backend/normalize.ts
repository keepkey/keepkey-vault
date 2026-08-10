/**
 * Pure Pioneer-response normalizers — no imports, no side effects, so they're
 * unit-testable without dragging in the electrobun/pioneer module chain.
 */
import type { BtcUtxo, BtcFeeRates } from './types'

/** Pioneer ListUnspent double-wraps (Swagger + Axios). Peel to the array. */
export function unwrapUtxos(resp: any): any[] {
  return Array.isArray(resp) ? resp
    : Array.isArray(resp?.data) ? resp.data
    : Array.isArray(resp?.data?.data) ? resp.data.data
    : Array.isArray(resp?.utxos) ? resp.utxos
    : []
}

export function normalizeUtxo(u: any): BtcUtxo {
  return {
    txid: u.txid,
    vout: u.vout,
    value: parseInt(u.value, 10) || 0,
    hex: u.tx?.hex || u.hex || undefined,
    scriptType: u.scriptType || undefined,
    path: u.path || undefined,
  }
}

/** Pioneer fee response → sat/vByte. Auto-detects sat/kB (values >500) and divides. */
export function normalizeFeeRates(resp: any): BtcFeeRates {
  const d = resp?.data || resp || {}
  const fast = d.fastest ?? d.fast
  const vals = [d.slow, d.average, fast].filter((v: any): v is number => typeof v === 'number')
  const perKb = vals.some((v) => v > 500)
  const conv = (v: number | undefined, fallback: number) =>
    Math.max(1, Math.ceil((typeof v === 'number' ? v : fallback) / (perKb ? 1000 : 1)))
  return {
    slow: conv(d.slow ?? d.average, 3),
    average: conv(d.average ?? fast, 5),
    fast: conv(fast ?? d.average, 15),
  }
}

export function extractTxid(resp: any): string | undefined {
  const d = resp?.data || resp
  return d?.txid || d?.tx_hash || d?.hash || undefined
}
