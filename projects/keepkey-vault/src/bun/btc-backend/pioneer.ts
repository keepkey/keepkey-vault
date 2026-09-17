/**
 * PioneerBackend — the default BtcBackend. The ONLY file in btc-backend/ allowed
 * to import ../pioneer. Behaviour is byte-identical to the direct Pioneer calls
 * it replaces (see sweep-engine.ts / txbuilder/utxo.ts history). Pure response
 * parsing lives in ./normalize (import-free, unit-tested).
 */
import type { BtcBackend } from './types'
import { utxoDiscoveryKey } from './types'
import {
  assertPioneerSuccess,
  unwrapUtxos,
  normalizeUtxo,
  normalizeFeeRates,
  extractTxid,
  extractRawTxHex,
} from './normalize'
import { addressIndicesFromTokens } from './address-discovery'

// Keep pure consumers of btc-backend/index.ts (transaction building, path
// generation, and their unit tests) from eagerly loading the Pioneer → DB →
// Electrobun runtime chain. The real client is loaded only when a Pioneer-backed
// network operation is actually requested.
async function getPioneerClient(): Promise<any> {
  const { getPioneer } = await import('../pioneer')
  return getPioneer()
}

export const PioneerBackend: BtcBackend = {
  kind: 'pioneer',
  capabilities: { history: true, push: true },

  async listUnspent({ network, xpub, address, scriptType }) {
    const key = xpub ? utxoDiscoveryKey(xpub, scriptType) : address
    if (!key) return []
    const pioneer = await getPioneerClient()
    const resp = await pioneer.ListUnspent({ network, xpub: key })
    assertPioneerSuccess(resp, 'ListUnspent')
    return unwrapUtxos(resp).map(normalizeUtxo).filter((u) => u.value > 0)
  },

  async feeRate(network) {
    const pioneer = await getPioneerClient()
    const resp = typeof pioneer.GetFeeRateByNetwork === 'function'
      ? await pioneer.GetFeeRateByNetwork({ networkId: network })
      : await pioneer.GetFeeRate({ networkId: network })
    assertPioneerSuccess(resp, 'GetFeeRate')
    return normalizeFeeRates(resp)
  },

  async broadcast({ network, rawTxHex }) {
    const pioneer = await getPioneerClient()
    const resp = await pioneer.Broadcast({ networkId: network, serialized: rawTxHex })
    assertPioneerSuccess(resp, 'Broadcast')
    const txid = extractTxid(resp)
    if (!txid) throw new Error(`Broadcast failed: ${JSON.stringify(resp?.data || resp).slice(0, 200)}`)
    return { txid }
  },

  async rawTxHex({ network, txid }) {
    const pioneer = await getPioneerClient()
    const lookup = pioneer.LookupUtxoTx || pioneer.UtxoLookup
    if (typeof lookup !== 'function') throw new Error('Pioneer client has no UTXO transaction lookup operation')
    const resp = await lookup.call(pioneer, { networkId: network, txid })
    assertPioneerSuccess(resp, 'LookupUtxoTx')
    return extractRawTxHex(resp)
  },

  async addressIndices({ network, xpub, scriptType }) {
    const pioneer = await getPioneerClient()
    const resp = await pioneer.GetPubkeyInfo({ network, xpub: utxoDiscoveryKey(xpub, scriptType) })
    assertPioneerSuccess(resp, 'GetPubkeyInfo')
    const outer = resp?.data ?? resp
    const data = outer?.data ?? outer
    if (!Array.isArray(data?.tokens)) {
      throw new Error('GetPubkeyInfo failed: Pioneer response omitted address tokens')
    }
    return addressIndicesFromTokens(data.tokens, 'pioneer')
  },
}
