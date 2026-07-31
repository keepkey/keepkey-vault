/**
 * PioneerBackend — the default BtcBackend. The ONLY file in btc-backend/ allowed
 * to load ../pioneer. Behaviour is byte-identical to the direct Pioneer calls
 * it replaces (see sweep-engine.ts / txbuilder/utxo.ts history). Keep the load
 * lazy: ../pioneer reaches the Electrobun database layer, and importing this
 * backend must remain side-effect-free for pure transaction-builder consumers.
 * Response parsing lives in ./normalize (import-free, unit-tested).
 */
import type { BtcBackend } from './types'
import { unwrapUtxos, normalizeUtxo, normalizeFeeRates, extractTxid } from './normalize'

async function getPioneerClient(): Promise<any> {
  const { getPioneer } = await import('../pioneer')
  return getPioneer()
}

export const PioneerBackend: BtcBackend = {
  kind: 'pioneer',
  capabilities: { history: true, push: true },

  async listUnspent({ network, xpub, address }) {
    const key = xpub ?? address
    if (!key) return []
    const pioneer = await getPioneerClient()
    const resp = await pioneer.ListUnspent({ network, xpub: key })
    return unwrapUtxos(resp).map(normalizeUtxo).filter((u) => u.value > 0)
  },

  async feeRate(network) {
    const pioneer = await getPioneerClient()
    const resp = typeof pioneer.GetFeeRateByNetwork === 'function'
      ? await pioneer.GetFeeRateByNetwork({ networkId: network })
      : await pioneer.GetFeeRate({ networkId: network })
    return normalizeFeeRates(resp)
  },

  async broadcast({ network, rawTxHex }) {
    const pioneer = await getPioneerClient()
    const resp = await pioneer.Broadcast({ networkId: network, serialized: rawTxHex })
    const txid = extractTxid(resp)
    if (!txid) throw new Error(`Broadcast failed: ${JSON.stringify(resp?.data || resp).slice(0, 200)}`)
    return { txid }
  },

  async rawTxHex({ network, txid }) {
    const pioneer = await getPioneerClient()
    const resp = await pioneer.UtxoLookup({ networkId: network, txid })
    const d = resp?.data || resp
    return d?.hex || d?.tx?.hex || undefined
  },
}
