/**
 * BtcBackend — the single seam for Bitcoin blockchain data.
 *
 * Pioneer's entire BTC surface is four ops: list UTXOs, fee rate, broadcast,
 * raw-tx-hex. Route them through this interface and both self-host (own node)
 * and offline (device-only) become "just another backend" instead of a rewrite.
 *
 * ISOLATION RULE: implementations live in sibling files and must NOT import
 * `../pioneer` — the ONLY exception is `pioneer.ts` (the default adapter).
 * Keeping node clients Pioneer-free is the whole point of this module.
 */

export type BtcBackendKind = 'pioneer' | 'core' | 'electrum' | 'blockbook' | 'esplora' | 'device-only'

/** Normalized UTXO — satoshi-integer value, optional raw prev-tx hex for legacy inputs. */
export interface BtcUtxo {
  txid: string
  vout: number
  value: number       // satoshis (integer)
  hex?: string        // raw prev-tx hex — needed to sign non-segwit (p2pkh) inputs
  scriptType?: string
  path?: string
}

/** Fee rates in sat/vByte. */
export interface BtcFeeRates {
  slow: number
  average: number
  fast: number
}

export interface BtcBackend {
  readonly kind: BtcBackendKind
  /** history=false → e.g. a pruned Core node via scantxoutset (balance+UTXO only). */
  readonly capabilities: { history: boolean; push: boolean }

  /** UTXOs for an xpub (gap scan) or a single address. Pioneer accepts either. */
  listUnspent(q: { network: string; xpub?: string; address?: string }): Promise<BtcUtxo[]>
  feeRate(network: string): Promise<BtcFeeRates>
  broadcast(q: { network: string; rawTxHex: string }): Promise<{ txid: string }>
  rawTxHex(q: { network: string; txid: string }): Promise<string | undefined>

  /** Tip height for a "Test connection" health check. Optional — only self-host needs it. */
  tipHeight?(): Promise<number>
}
