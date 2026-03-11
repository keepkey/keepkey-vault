/**
 * Pure parsing functions for Pioneer swap API responses.
 *
 * Extracted from swap.ts to allow unit testing without side effects
 * (no Pioneer client, no DB, no server imports).
 */
import { CHAINS } from '../shared/chains'
import type { SwapAsset, SwapQuote } from '../shared/types'

const TAG = '[swap]'

// ── Asset mapping helpers ───────────────────────────────────────────

/** Parse a THORChain asset string (e.g. "ETH.USDT-0xDAC...") into parts */
export function parseThorAsset(asset: string): { chain: string; symbol: string; contractAddress?: string } {
  const [chain, rest] = asset.split('.')
  if (!rest) return { chain, symbol: chain }
  const dashIdx = rest.indexOf('-')
  if (dashIdx === -1) return { chain, symbol: rest }
  return { chain, symbol: rest.slice(0, dashIdx), contractAddress: rest.slice(dashIdx + 1) }
}

/** Map THORChain chain prefixes to our chain IDs */
export const THOR_TO_CHAIN: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  LTC: 'litecoin',
  DOGE: 'dogecoin',
  BCH: 'bitcoincash',
  DASH: 'dash',
  GAIA: 'cosmos',
  THOR: 'thorchain',
  MAYA: 'mayachain',
  AVAX: 'avalanche',
  BSC: 'bsc',
  BASE: 'base',
  ARB: 'arbitrum',
  OP: 'optimism',
  MATIC: 'polygon',
}

// ── Quote parsing ───────────────────────────────────────────────────

/**
 * Parse a raw Pioneer Quote SDK response into our SwapQuote type.
 * Pure function — no network calls, no side effects.
 */
export function parseQuoteResponse(
  quoteResp: any,
  params: { fromAsset: string; toAsset: string; slippageBps?: number },
): SwapQuote {
  // Pioneer SDK wraps responses: { data: { success, data: [...] } }
  const qOuter = quoteResp?.data || quoteResp
  const qInner = qOuter?.data || qOuter
  if (!qInner) throw new Error('Pioneer Quote returned empty response')

  // Pioneer returns array of quotes from different integrations — pick best
  const quotes: any[] = Array.isArray(qInner) ? qInner : [qInner]
  if (quotes.length === 0) throw new Error('No quotes available for this pair')

  // Select first (best) quote
  const best = quotes[0]
  const quote = best.quote || best
  // Pioneer wraps THORNode data in quote.raw and tx details in quote.txs[]
  const raw = quote.raw || {}
  const txParams = quote.txs?.[0]?.txParams || {}

  // Extract fields from Pioneer's normalized fields + raw THORNode data
  const expectedOutput = quote.buyAmount || quote.amountOut || raw.expected_amount_out
  if (!expectedOutput) throw new Error('Quote response missing output amount')
  const expectedOutputStr = String(expectedOutput)

  // Memo lives in txParams (Pioneer constructs it), fallback to raw
  const memo = txParams.memo || quote.memo || raw.memo || ''
  // Router: raw.router or txParams.recipientAddress (Pioneer sets recipient = router for EVM)
  const router = raw.router || quote.router || txParams.recipientAddress
  // Vault/inbound address — check both snake_case and camelCase across all layers
  let inboundAddress = quote.inbound_address || quote.inboundAddress
    || raw.inbound_address || raw.inboundAddress
    || txParams.vaultAddress || txParams.vault_address
    || txParams.to
    || best.inbound_address || best.inboundAddress

  // Last-resort fallback: for UTXO swaps, THORChain's "router" IS the vault address
  // (EVM router is a contract, but UTXO "router" is the inbound vault)
  if (!inboundAddress && router) {
    console.warn(`${TAG} No explicit inbound_address — falling back to router: ${router}`)
    inboundAddress = router
  }

  // Expiry for depositWithExpiry
  const expiry = raw.expiry || quote.expiry || 0

  if (!inboundAddress) {
    // Dump full response structure to help diagnose missing field
    console.error(`${TAG} MISSING inbound address — dumping response structure:`)
    console.error(`${TAG}   best keys: ${Object.keys(best).join(', ')}`)
    console.error(`${TAG}   quote keys: ${Object.keys(quote).join(', ')}`)
    console.error(`${TAG}   raw keys: ${Object.keys(raw).join(', ')}`)
    console.error(`${TAG}   txParams keys: ${Object.keys(txParams).join(', ')}`)
    console.error(`${TAG}   full best: ${JSON.stringify(best, null, 2).slice(0, 2000)}`)
    throw new Error('Quote response missing inbound address')
  }
  if (!memo) console.warn(`${TAG} WARNING: Quote has no memo — tx may fail`)

  // Extract fees from raw THORNode response
  const fees = raw.fees || quote.fees || {}
  const totalBps = fees.total_bps || fees.totalBps || 0
  const outboundFee = fees.outbound || fees.outboundFee || '0'
  const affiliateFee = fees.affiliate || fees.affiliateFee || '0'
  const actualSlippageBps = fees.slippage_bps || fees.slippageBps || (params.slippageBps ?? 300)

  // Minimum output — Pioneer provides amountOutMin, fallback to slippage calc
  const expectedNum = parseFloat(expectedOutputStr)
  const minOut = quote.amountOutMin
    ? parseFloat(quote.amountOutMin)
    : expectedNum * (1 - actualSlippageBps / 10000)

  // Estimated time — prefer total_swap_seconds (full swap duration) over
  // inbound_confirmation_seconds (just the inbound leg, much shorter)
  const estimatedTime = raw.total_swap_seconds || quote.totalSwapSeconds
    || quote.estimatedTime || raw.inbound_confirmation_seconds || 600

  const minOutStr = minOut > 0 ? minOut.toFixed(8).replace(/\.?0+$/, '') : '0'

  return {
    expectedOutput: expectedOutputStr,
    minimumOutput: minOutStr,
    inboundAddress,
    router,
    memo,
    expiry: Number(expiry),
    fees: {
      affiliate: String(affiliateFee),
      outbound: String(outboundFee),
      totalBps: Number(totalBps),
    },
    estimatedTime: Number(estimatedTime),
    warning: raw.warning || quote.warning || undefined,
    slippageBps: Number(actualSlippageBps),
    fromAsset: params.fromAsset,
    toAsset: params.toAsset,
    integration: best.integration || 'thorchain',
  }
}

// ── Assets parsing ──────────────────────────────────────────────────

/**
 * Parse a raw Pioneer GetAvailableAssets response into SwapAsset[].
 * Pure function — no network calls, no side effects.
 */
export function parseAssetsResponse(resp: any): SwapAsset[] {
  const outer = resp?.data || resp
  const inner = outer?.data || outer
  if (!inner) throw new Error('Pioneer GetAvailableAssets returned empty response')

  const rawAssets: any[] = inner.assets || inner
  if (!Array.isArray(rawAssets)) {
    throw new Error('Pioneer GetAvailableAssets: unexpected response shape')
  }

  const assets: SwapAsset[] = []

  for (const raw of rawAssets) {
    const thorAsset = raw.asset || raw.thorAsset || raw.name
    if (!thorAsset) continue

    const parsed = parseThorAsset(thorAsset)
    const ourChainId = THOR_TO_CHAIN[parsed.chain]
    if (!ourChainId) continue

    const chainDef = CHAINS.find(c => c.id === ourChainId)
    if (!chainDef) continue

    const isToken = !!parsed.contractAddress

    assets.push({
      asset: thorAsset,
      chainId: ourChainId,
      symbol: raw.symbol || parsed.symbol,
      name: raw.name || (isToken ? `${parsed.symbol} (${chainDef.coin})` : chainDef.coin),
      chainFamily: chainDef.chainFamily as 'utxo' | 'evm' | 'cosmos' | 'xrp',
      decimals: raw.decimals ?? chainDef.decimals,
      caip: raw.caip || chainDef.caip,
      contractAddress: parsed.contractAddress,
      icon: raw.icon || raw.image,
    })
  }

  return assets
}

/** Convert our chain CAIP + asset info into the CAIP format Pioneer Quote expects */
export function assetToCaip(thorAsset: string): string {
  const parsed = parseThorAsset(thorAsset)
  const ourChainId = THOR_TO_CHAIN[parsed.chain]
  if (!ourChainId) throw new Error(`Unsupported THORChain chain: ${parsed.chain}`)

  const chainDef = CHAINS.find(c => c.id === ourChainId)
  if (!chainDef) throw new Error(`No chain def for: ${ourChainId}`)

  // For ERC-20 tokens, build eip155:N/erc20:0x... CAIP
  if (parsed.contractAddress) {
    const networkParts = chainDef.networkId // e.g. "eip155:1"
    return `${networkParts}/erc20:${parsed.contractAddress}`
  }

  // Native asset — use the chain's CAIP-19
  return chainDef.caip
}
