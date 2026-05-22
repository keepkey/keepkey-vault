/**
 * Pure parsing functions for Pioneer swap API responses.
 *
 * Extracted from swap.ts to allow unit testing without side effects
 * (no Pioneer client, no DB, no server imports).
 */
import { CHAINS } from '../shared/chains'
import type { SwapAsset, SwapQuote, RelayTxParams } from '../shared/types'
import { COIN_MAP_LONG } from '@pioneer-platform/pioneer-coins'

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

/** Map THORChain chain prefixes to our vault chain IDs.
 *
 *  Source of truth: `@pioneer-platform/pioneer-coins` `COIN_MAP_LONG`. The
 *  overlay below covers two narrow gaps:
 *    1. BSC mismatch — pioneer-coins maps `BSC → 'binance'`, but vault's
 *       chains.ts uses `'bsc'` as the chain id; we override here.
 *    2. Long-form aliases (OPTIMISM, ARBITRUM, BASE, etc.) — ShapeShift
 *       swapper and ad-hoc paths sometimes emit the long chain name. Without
 *       these, parseThorAsset throws "Unsupported THORChain chain: OPTIMISM"
 *       on tokens like VELO routed via ShapeShift.
 *    3. TRON alias — THORChain memos use `TRON.TRX`, pioneer-coins only has
 *       the symbol form `TRX`. */
export const THOR_TO_CHAIN: Record<string, string> = {
  ...COIN_MAP_LONG,
  // Vault chain-id overrides (where vault and pioneer-coins disagree)
  BSC:  'bsc',
  BNB:  'bsc',
  // THORChain memo aliases not in pioneer-coins
  TRON: 'tron',
  // Long-form aliases — defensive against ShapeShift swapper output
  ETHEREUM:    'ethereum',
  AVALANCHE:   'avalanche',
  ARBITRUM:    'arbitrum',
  OPTIMISM:    'optimism',
  POLYGON:     'polygon',
  BITCOIN:     'bitcoin',
  LITECOIN:    'litecoin',
  DOGECOIN:    'dogecoin',
  BITCOINCASH: 'bitcoincash',
  COSMOS:      'cosmos',
  SOLANA:      'solana',
  RIPPLE:      'ripple',
}

// VAULT_CHAIN_TO_THOR lives in shared/swap-discovery.ts so both bun and
// frontend can use it without crossing the layer boundary. Re-exported here
// for callers that already import from this module.
export { VAULT_CHAIN_TO_THOR } from '../shared/swap-discovery'

// ── Quote parsing ───────────────────────────────────────────────────

/**
 * Parse a raw Pioneer Quote SDK response into our SwapQuote type.
 * Pure function — no network calls, no side effects.
 *
 * Supports two integration styles:
 *   1. THORChain/ChainFlip/etc. — memo-based: send to vault with routing memo
 *   2. Relay — pre-built tx: calldata encodes the swap, no memo needed
 */
export function parseQuoteResponse(
  quoteResp: any,
  params: { fromCaip: string; toCaip: string; slippageBps?: number },
): SwapQuote {
  // Pioneer SDK wraps responses: { data: { success, data: [...] } }
  const qOuter = quoteResp?.data || quoteResp
  const qInner = qOuter?.data || qOuter
  if (!qInner) throw new Error('Pioneer Quote returned empty response')

  // Pioneer returns array of quotes from different integrations — pick best
  const quotes: any[] = Array.isArray(qInner) ? qInner : [qInner]
  if (quotes.length === 0) throw new Error('No quotes available for this pair')

  const best = quotes[0]
  const integration = best.integration || 'thorchain'
  const quote = best.quote || best
  // Pioneer wraps THORNode data in quote.raw and tx details in quote.txs[]
  const raw = quote.raw || {}
  const txParams = quote.txs?.[0]?.txParams || {}
  // Underlying protocol for aggregator integrations. ShapeShift surfaces this
  // as quote.swapper (and quote.meta.swapper) — e.g. "Relay", "Thorchain", "0x",
  // "Uniswap". Falls back to undefined for direct integrations (THORChain,
  // ChainFlip) where `integration` already names the protocol.
  const swapperRaw = quote.swapper || quote.meta?.swapper || raw.swapper
  const swapper = swapperRaw && typeof swapperRaw === 'string' && swapperRaw.toLowerCase() !== 'unknown'
    ? swapperRaw
    : undefined

  // Extract fields from Pioneer's normalized fields + raw THORNode data.
  // Snake_case fallbacks added because Pioneer's Quote response has drifted —
  // some integrations now return `expectedAmountOut` / `amount_out` / etc.
  const expectedOutput = quote.buyAmount
    ?? quote.amountOut
    ?? quote.expectedAmountOut
    ?? quote.expected_amount_out
    ?? quote.amount_out
    ?? raw.expected_amount_out
    ?? raw.expectedAmountOut
  if (expectedOutput == null || expectedOutput === '' || expectedOutput === 0 || expectedOutput === '0') {
    // Dump field shapes so we can see exactly what Pioneer returned. This is
    // the "expected output coming back 0" path users hit when a pool has no
    // liquidity or Pioneer drifts its schema; without this dump the bug is
    // invisible in production logs.
    console.error(`${TAG} expectedOutput is empty/zero — dumping response structure:`)
    console.error(`${TAG}   integration: ${integration}`)
    console.error(`${TAG}   best keys: ${Object.keys(best).join(', ')}`)
    console.error(`${TAG}   quote keys: ${Object.keys(quote).join(', ')}`)
    console.error(`${TAG}   raw keys: ${Object.keys(raw).join(', ')}`)
    console.error(`${TAG}   txParams keys: ${Object.keys(txParams).join(', ')}`)
    console.error(`${TAG}   first 2KB of best: ${JSON.stringify(best, null, 2).slice(0, 2000)}`)
    throw new Error(`No quote output for ${params.fromCaip} → ${params.toCaip} — pool may have no liquidity, or Pioneer schema has drifted (see backend logs for response shape)`)
  }
  const expectedOutputStr = String(expectedOutput)

  // ── Pre-built calldata integrations (relay, shapeshiftSwap, …) ──
  // Any integration that hands us calldata gets the same treatment: we sign
  // the supplied tx as-is. The field stays named `relayTx` for backwards
  // compatibility with ExecuteSwapParams; conceptually it's "prebuilt tx".
  //
  // Two sub-cases:
  //  A) Real calldata (data.length ≥ 10): encodes the swap instruction (Relay, 0x, …)
  //  B) Deposit-channel (data = '0x' / empty): Chainflip uses a plain ETH transfer to a
  //     protocol-controlled address; the swap destination was registered off-chain when
  //     the quote/channel was created. `data` is empty intentionally — do NOT conflate
  //     with a malformed Relay quote.
  const rawData: string | undefined = txParams.data
  const hasRealCalldata = !!rawData && rawData !== '0x' && rawData !== '0x0' && rawData.length >= 10

  // Deposit-channel protocols send a plain native transfer (data = '0x') to a
  // protocol-controlled address. The BTC/etc. destination is registered off-chain.
  // Allowed list is narrow and explicit — unknown swappers with empty calldata
  // are rejected by buildRelaySwapTx's ERC-20 guard if applicable, and warned
  // by the pre-existing cross-chain guard.
  const fromIsUtxo = params.fromCaip.startsWith('bip122:')
  // Deposit-channel only applies when source is EVM. For UTXO sources (BTC→ETH via
  // NEAR Intents), the txParams.to is a Bitcoin address and we use the inboundAddress
  // path instead (isMemolessTransfer below).
  const DEPOSIT_CHANNEL_SWAPPERS = new Set(['Chainflip', 'NEAR Intents'])
  const isDepositChannel = !hasRealCalldata && !fromIsUtxo && !!txParams.to && DEPOSIT_CHANNEL_SWAPPERS.has(swapper ?? '')
  const hasPrebuiltTx = hasRealCalldata || isDepositChannel
  let relayTx: RelayTxParams | undefined

  if (hasPrebuiltTx) {
    // Pioneer occasionally returns addresses with a duplicate '0x' prefix (e.g.
    // "0x0x833589..."). Strip all leading '0x' pairs and re-add exactly one.
    // Affects NEAR Intents ERC-20 routes where txParams.to is the token contract.
    const normalizeAddr = (addr: string | undefined): string | undefined =>
      addr ? addr.replace(/^(0x)+/i, '0x') : addr
    relayTx = {
      to: normalizeAddr(txParams.to) as string,
      data: rawData ?? '0x',
      value: String(txParams.value || '0'),
      // Leave gasLimit undefined when Pioneer omits it so buildRelaySwapTx
      // can apply its chain-aware fallback (300000 is only correct for Arbitrum).
      gasLimit: (txParams.gasLimit || txParams.gas) ? String(txParams.gasLimit || txParams.gas) : undefined,
      maxFeePerGas: txParams.maxFeePerGas ? String(txParams.maxFeePerGas) : undefined,
      maxPriorityFeePerGas: txParams.maxPriorityFeePerGas ? String(txParams.maxPriorityFeePerGas) : undefined,
      chainId: txParams.chainId,
      isDepositChannel: isDepositChannel || undefined,
    }
    console.log(`${TAG} ${integration} (${swapper}) — prebuilt tx extracted (to=${relayTx.to}, depositChannel=${isDepositChannel})`)
  }

  // Memo lives in txParams (Pioneer constructs it), fallback to raw
  // Relay quotes don't use memos — the calldata IS the swap instruction
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

  // Guard: UTXO sources must send to a chain-native address, not an EVM address.
  if (fromIsUtxo && inboundAddress && inboundAddress.startsWith('0x')) {
    console.error(`${TAG} Pioneer returned EVM address ${inboundAddress} as inbound address for a UTXO source. Dumping quote:`)
    console.error(`${TAG}   txParams keys: ${Object.keys(txParams).join(', ')}`)
    console.error(`${TAG}   txParams: ${JSON.stringify(txParams, null, 2).slice(0, 2000)}`)
    console.error(`${TAG}   best keys: ${Object.keys(best).join(', ')}`)
    throw new Error('Swap quote did not provide a valid deposit address for this chain. Try a different pair or refresh the quote.')
  }

  // Expiry for depositWithExpiry
  const expiry = raw.expiry || quote.expiry || 0

  // Native THORChain/Maya swaps (RUNE, CACAO) use MsgDeposit — no inbound vault needed
  const isNativeDeposit =
    params.fromCaip === 'cosmos:thorchain-mainnet-v1/slip44:931' ||
    params.fromCaip === 'cosmos:mayachain-mainnet-v1/slip44:931'

  if (!inboundAddress && !isNativeDeposit && !hasPrebuiltTx) {
    // Dump full response structure to help diagnose missing field
    console.error(`${TAG} MISSING inbound address — dumping response structure:`)
    console.error(`${TAG}   best keys: ${Object.keys(best).join(', ')}`)
    console.error(`${TAG}   quote keys: ${Object.keys(quote).join(', ')}`)
    console.error(`${TAG}   raw keys: ${Object.keys(raw).join(', ')}`)
    console.error(`${TAG}   txParams keys: ${Object.keys(txParams).join(', ')}`)
    console.error(`${TAG}   full best: ${JSON.stringify(best, null, 2).slice(0, 2000)}`)
    throw new Error('Quote response missing inbound address')
  }
  // For memo-less UTXO swaps (NEAR Intents BTC→ETH): the deposit address IS the
  // only instruction — no memo or calldata needed. fromIsUtxo guards direction:
  // EVM→BTC with no calldata has no way to encode the BTC destination.
  const isMemolessTransfer = fromIsUtxo && !!inboundAddress && swapper === 'NEAR Intents'
  if (!memo && !hasPrebuiltTx && !isNativeDeposit && !isMemolessTransfer) {
    console.error(`${TAG} MISSING memo + no prebuilt tx — dumping response structure:`)
    console.error(`${TAG}   integration: ${integration}, swapper: ${swapper ?? 'none'}`)
    console.error(`${TAG}   best keys: ${Object.keys(best).join(', ')}`)
    console.error(`${TAG}   quote keys: ${Object.keys(quote).join(', ')}`)
    console.error(`${TAG}   raw keys: ${Object.keys(raw).join(', ')}`)
    console.error(`${TAG}   txParams keys: ${Object.keys(txParams).join(', ')}`)
    console.error(`${TAG}   txParams.memo=${txParams.memo!}, quote.memo=${quote.memo!}, raw.memo=${raw.memo!}`)
    console.error(`${TAG}   rawData=${rawData!}, hasRealCalldata=${hasRealCalldata}, isDepositChannel=${isDepositChannel}`)
    console.error(`${TAG}   full best: ${JSON.stringify(best, null, 2).slice(0, 3000)}`)
    const swapperLabel = swapper || integration || 'unknown'
    throw new Error(`No supported routes for this pair — Pioneer returned only "${swapperLabel}" (unsupported). Try a different pair or refresh.`)
  }

  // Extract fees — relay uses a different fee structure
  const fees = raw.fees || quote.fees || {}
  let totalBps = fees.total_bps || fees.totalBps || 0
  let outboundFee = fees.outbound || fees.outboundFee || '0'
  let affiliateFee = fees.affiliate || fees.affiliateFee || '0'
  const actualSlippageBps = fees.slippage_bps || fees.slippageBps || (params.slippageBps ?? 100)

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

  // Minimum sell amount — solvers/protocols may refuse amounts below this floor
  // Check multiple field names across the response layers (Pioneer schema varies by swapper)
  const minAmountInRaw = quote.minAmountIn ?? best.minAmountIn ?? raw.min_amount_in ?? raw.minAmountIn
  const minAmountIn: string | undefined = minAmountInRaw != null ? String(minAmountInRaw) : undefined

  // For NEAR Intents ERC-20 routes, Pioneer embeds the 1Click deposit address in
  // txParams.recipientAddress (same as quote.meta.depositAddress). This is the
  // address funds are actually sent to — distinct from inboundAddress which may
  // resolve to the token contract for relay routes.
  const nearIntentsDepositAddress = swapper === 'NEAR Intents'
    ? (txParams.recipientAddress || (quote.meta as any)?.depositAddress || undefined)
    : undefined

  return {
    expectedOutput: expectedOutputStr,
    minimumOutput: minOutStr,
    inboundAddress: inboundAddress || '',
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
    integration,
    swapper,
    relayTx,
    minAmountIn,
    nearIntentsDepositAddress,
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

    // CAIP is required for tokens — pioneer-server's swap-config controller
    // ALWAYS emits it (verified live; the response is keyed on CAIP). If a
    // token entry arrives without one, that's a malformed Pioneer response;
    // dropping the asset is safer than falling back to the native chain CAIP,
    // which would silently quote / attach the wrong asset (e.g. ETH.USDT
    // routing as eip155:1/slip44:60 — native ETH).
    let caip: string
    if (isToken) {
      if (!raw.caip) {
        console.warn(`[swap] dropping token ${thorAsset} — pioneer-server response missing caip`)
        continue
      }
      caip = raw.caip
    } else {
      // Native: chainDef.caip is correct by definition (chain native = chain CAIP).
      caip = raw.caip || chainDef.caip
    }

    assets.push({
      asset: thorAsset,
      chainId: ourChainId,
      symbol: raw.symbol || parsed.symbol,
      name: raw.name || (isToken ? `${parsed.symbol} (${chainDef.coin})` : chainDef.coin),
      chainFamily: chainDef.chainFamily,
      decimals: raw.decimals ?? chainDef.decimals,
      caip,
      contractAddress: parsed.contractAddress,
      icon: raw.icon || raw.image,
    })
  }

  return assets
}

/** Convert our chain CAIP + asset info into the CAIP format Pioneer Quote expects.
 *
 *  Prefer the canonical caip from the cached SwapAsset list (pioneer is the
 *  source of truth — it knows that TRON tokens use `/token:T...` with the
 *  case-sensitive base58 address, while EVM tokens use `/erc20:0x...`). The
 *  reconstruct path only fires when we don't have a cached asset (e.g. the
 *  legacy code path passing arbitrary thor-asset strings).
 *
 *  The bug this guards against: reconstructing always emitted `/erc20:` and
 *  preserved THORChain's uppercase form of the contract address. For TRON
 *  USDT, that produced `tron:.../erc20:TR7NHQJ...` instead of pioneer's
 *  canonical `tron:.../token:TR7NHqj...`, and pioneer-router rejected the
 *  quote with "No quotes available". */
export function assetToCaip(thorAsset: string, knownAssets?: SwapAsset[]): string {
  // Prefer the canonical caip pioneer gave us — it has the right namespace
  // (/token: vs /erc20:) and the right case for chains where it matters.
  const known = knownAssets?.find(a => a.asset === thorAsset)
  if (known?.caip) return known.caip

  const parsed = parseThorAsset(thorAsset)
  const ourChainId = THOR_TO_CHAIN[parsed.chain]
  if (!ourChainId) throw new Error(`Unsupported THORChain chain: ${parsed.chain}`)

  const chainDef = CHAINS.find(c => c.id === ourChainId)
  if (!chainDef) throw new Error(`No chain def for: ${ourChainId}`)

  if (parsed.contractAddress) {
    // Token namespace differs by chain family. Without a cached SwapAsset
    // we can only pick the right namespace heuristically — and for TRON we
    // can't recover the case-sensitive base58 address from THORChain's
    // uppercased form, so the result may still be invalid. Callers that
    // need TRON tokens should pass `knownAssets` so we hit the canonical
    // path above.
    const tokenNamespace = chainDef.chainFamily === 'tron' ? 'token' : 'erc20'
    return `${chainDef.networkId}/${tokenNamespace}:${parsed.contractAddress}`
  }

  // Native asset — use the chain's CAIP-19
  return chainDef.caip
}
