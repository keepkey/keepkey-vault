/**
 * PioneerBackend — the default BtcBackend. The ONLY file in btc-backend/ allowed
 * to import ../pioneer. Behaviour is byte-identical to the direct Pioneer calls
 * it replaces (see sweep-engine.ts / txbuilder/utxo.ts history). Pure response
 * parsing lives in ./normalize (import-free, unit-tested).
 */
import { getPioneer } from '../pioneer'
import type { BtcBackend } from './types'
import { utxoDiscoveryKey } from './types'
import { unwrapUtxos, normalizeUtxo, normalizeFeeRates, extractTxid } from './normalize'

export const PioneerBackend: BtcBackend = {
  kind: 'pioneer',
  capabilities: { history: true, push: true },

  async listUnspent({ network, xpub, address, scriptType }) {
    const key = xpub ? utxoDiscoveryKey(xpub, scriptType) : address
    if (!key) return []
    const pioneer = await getPioneer()
    const resp = await pioneer.ListUnspent({ network, xpub: key })
    return unwrapUtxos(resp).map(normalizeUtxo).filter((u) => u.value > 0)
  },

  async feeRate(network) {
    const pioneer = await getPioneer()
    const resp = typeof pioneer.GetFeeRateByNetwork === 'function'
      ? await pioneer.GetFeeRateByNetwork({ networkId: network })
      : await pioneer.GetFeeRate({ networkId: network })
    return normalizeFeeRates(resp)
  },

  async broadcast({ network, rawTxHex }) {
    const pioneer = await getPioneer()
    const resp = await pioneer.Broadcast({ networkId: network, serialized: rawTxHex })
    const txid = extractTxid(resp)
    if (!txid) throw new Error(`Broadcast failed: ${JSON.stringify(resp?.data || resp).slice(0, 200)}`)
    return { txid }
  },

  async rawTxHex({ network, txid }) {
    const pioneer = await getPioneer()
    const resp = await pioneer.UtxoLookup({ networkId: network, txid })
    const d = resp?.data || resp
    return d?.hex || d?.tx?.hex || undefined
  },
}
