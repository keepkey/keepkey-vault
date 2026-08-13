/**
 * REST v2 data routes — exposes chain data (balances, prices, UTXOs, tx history, swap quotes)
 * on localhost:1646 under /api/v2/*.
 *
 * All endpoints require bearer-token auth.
 * Pattern: parse body → call backend → return { data: ... }.
 */
import type { AuthStore } from './auth'
import { getPioneer } from './pioneer'
import { parseRequest } from './validate'
import * as S from './schemas'
import { utxoDiscoveryKey } from './btc-backend/types'

const TAG = '[rest-v2]'

type JsonFn = (data: unknown, status?: number) => Response

/**
 * Handle /api/v2/ data routes. Returns a Response if matched, null otherwise.
 */
export async function handleV2DataRoute(
  path: string,
  method: string,
  req: Request,
  auth: AuthStore,
  json: JsonFn,
): Promise<Response | null> {
  try {
    // ── Portfolio & Market ──────────────────────────────────────────

    if (path === '/api/v2/portfolio/balances' && method === 'POST') {
      auth.requireAuth(req)
      const body = await parseRequest(req, S.PortfolioBalancesRequest)
      const pioneer = await getPioneer()
      const resp = await pioneer.GetPortfolioBalances({
        pubkeys: body.pubkeys.map(p => ({ caip: p.caip, pubkey: utxoDiscoveryKey(p.pubkey, p.scriptType) })),
      }, { forceRefresh: true })
      return json({ data: resp?.data || resp })
    }

    if (path === '/api/v2/market/info' && method === 'POST') {
      auth.requireAuth(req)
      const body = await parseRequest(req, S.MarketInfoRequest)
      const pioneer = await getPioneer()
      const resp = await pioneer.GetMarketInfo(body.caips)
      return json({ data: resp?.data || resp })
    }

    // ── Assets ─────────────────────────────────────────────────────

    if (path === '/api/v2/assets/available' && method === 'GET') {
      auth.requireAuth(req)
      const pioneer = await getPioneer()
      const resp = await pioneer.GetAvailableAssets()
      return json({ data: resp?.data || resp })
    }

    if (path === '/api/v2/assets/search' && method === 'POST') {
      auth.requireAuth(req)
      const body = await parseRequest(req, S.SearchAssetsRequest)
      const pioneer = await getPioneer()
      const resp = await pioneer.SearchAssets({ q: body.q, limit: body.limit || 100 })
      return json({ data: resp?.data || resp })
    }

    // ── UTXO ───────────────────────────────────────────────────────

    if (path === '/api/v2/utxo/unspent' && method === 'POST') {
      auth.requireAuth(req)
      const body = await parseRequest(req, S.ListUnspentRequest)
      const pioneer = await getPioneer()
      const resp = await pioneer.ListUnspent({
        network: body.network,
        xpub: utxoDiscoveryKey(body.xpub, body.scriptType),
      })
      return json({ data: resp?.data || resp })
    }

    if (path === '/api/v2/utxo/pubkey-info' && method === 'POST') {
      auth.requireAuth(req)
      const body = await parseRequest(req, S.PubkeyInfoRequest)
      const pioneer = await getPioneer()
      const resp = await pioneer.GetPubkeyInfo({
        network: body.network,
        xpub: utxoDiscoveryKey(body.xpub, body.scriptType),
      })
      return json({ data: resp?.data || resp })
    }

    // ── Transactions ───────────────────────────────────────────────

    if (path === '/api/v2/tx/history' && method === 'POST') {
      auth.requireAuth(req)
      const body = await parseRequest(req, S.TxHistoryRequest)
      const pioneer = await getPioneer()
      const resp = await pioneer.GetTransactionHistory({
        queries: body.queries.map(q => ({ caip: q.caip, pubkey: utxoDiscoveryKey(q.pubkey, q.scriptType) })),
      })
      return json({ data: resp?.data || resp })
    }

    if (path === '/api/v2/tx/broadcast' && method === 'POST') {
      auth.requireAuth(req)
      const body = await parseRequest(req, S.BroadcastRequest)
      const pioneer = await getPioneer()
      const resp = await pioneer.Broadcast({ networkId: body.networkId, serialized: body.serialized })
      return json({ data: resp?.data || resp })
    }

    // ── Network info ───────────────────────────────────────────────

    if (path === '/api/v2/network/fee-rate' && method === 'POST') {
      auth.requireAuth(req)
      const body = await parseRequest(req, S.NetworkIdRequest)
      const pioneer = await getPioneer()
      // Older Pioneer clients expose GetFeeRate instead. btc-backend/pioneer.ts
      // and txbuilder/utxo.ts already fall back; this route did not, so it 500'd
      // with "GetFeeRateByNetwork is not a function" against those clients.
      const resp = typeof pioneer.GetFeeRateByNetwork === 'function'
        ? await pioneer.GetFeeRateByNetwork({ networkId: body.networkId })
        : await pioneer.GetFeeRate({ networkId: body.networkId })
      return json({ data: resp?.data || resp })
    }

    if (path === '/api/v2/network/gas-price' && method === 'POST') {
      auth.requireAuth(req)
      const body = await parseRequest(req, S.NetworkIdRequest)
      const pioneer = await getPioneer()
      const resp = await pioneer.GetGasPriceByNetwork({ networkId: body.networkId })
      return json({ data: resp?.data || resp })
    }

    if (path === '/api/v2/network/nonce' && method === 'POST') {
      auth.requireAuth(req)
      const body = await parseRequest(req, S.NetworkAddressRequest)
      const pioneer = await getPioneer()
      const resp = await pioneer.GetNonceByNetwork({ networkId: body.networkId, address: body.address })
      return json({ data: resp?.data || resp })
    }

    if (path === '/api/v2/network/balance' && method === 'POST') {
      auth.requireAuth(req)
      const body = await parseRequest(req, S.NetworkAddressRequest)
      const pioneer = await getPioneer()
      const resp = await pioneer.GetBalanceAddressByNetwork({ networkId: body.networkId, address: body.address })
      return json({ data: resp?.data || resp })
    }

    if (path === '/api/v2/network/token-decimals' && method === 'POST') {
      auth.requireAuth(req)
      const body = await parseRequest(req, S.TokenDecimalsRequest)
      const pioneer = await getPioneer()
      const resp = await pioneer.GetTokenDecimals({ networkId: body.networkId, contractAddress: body.contractAddress })
      return json({ data: resp?.data || resp })
    }

    // ── Staking ────────────────────────────────────────────────────

    if (path === '/api/v2/staking/positions' && method === 'POST') {
      auth.requireAuth(req)
      const body = await parseRequest(req, S.StakingRequest)
      const pioneer = await getPioneer()
      const resp = await pioneer.GetStakingPositions({ network: body.network, address: body.address })
      return json({ data: resp?.data || resp })
    }

    // ── Swap routes moved to rest-swap.ts (/api/v2/swap/*) ────────────

    return null

  } catch (err: any) {
    if (err.status) throw err
    console.error(`${TAG} Error on ${path}:`, err.message)
    return json({ error: 'API error', details: err.message }, 502)
  }
}
