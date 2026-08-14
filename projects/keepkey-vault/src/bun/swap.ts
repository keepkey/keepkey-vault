/**
 * Swap service — Pioneer API integration for cross-chain swaps.
 *
 * ALL swap data flows through Pioneer (api.keepkey.info):
 *   - Available assets: Pioneer GetAvailableAssets
 *   - Quotes: Pioneer Quote (aggregates THORChain, ShapeShift, ChainFlip, etc.)
 *   - Execution: builds, signs (on device), and broadcasts swap txs
 *
 * NO direct THORNode or other third-party calls — fail fast if Pioneer is down.
 */
import { CHAINS, supportedBtcScriptTypes, btcAccountPath, evmAddressPath } from '../shared/chains'
import type { ChainDef } from '../shared/chains'
import type { SwapAsset, SwapQuote, SwapQuoteParams, ExecuteSwapParams, SwapResult } from '../shared/types'
import { SOLANA_BLIND_SIGNING_REQUIRED } from '../shared/types'
import { toDeviceError, deviceErrorMessage } from '../shared/device-error'
import { findEvmSchema } from './evm-schema-registry'
import { findSolanaSchema } from './solana-schema-registry'
import { getPioneer } from './pioneer'
import { encodeDepositWithExpiry, encodeApprove, parseUnits, toHex } from './txbuilder/evm'
import { getEvmGasPrice, getEvmFeeData, getEvmNonce, getEvmBalance, getErc20Allowance, getErc20Balance, getErc20Decimals, broadcastEvmTx, EvmSignerVerificationError, waitForTxReceipt, estimateGas } from './evm-rpc'
import * as txb from './txbuilder'
import { normalizeBchAddress } from './txbuilder'
// Re-export pure parsing functions (used by tests + this module)
// assetToCaip is exported for backwards-compat (legacy code that hydrates old
// history rows without CAIP). The swap quote/execute path no longer uses it —
// vault is CAIP-native end-to-end.
export { parseAssetsResponse, parseQuoteResponse, assetToCaip } from './swap-parsing'
import {
  assertSwapMemoFitsSource,
  parseQuoteResponse,
  parseAssetsResponse,
  isNativeDepositCaip,
} from './swap-parsing'

const TAG = '[swap]'

// CAIP-2 of Bitcoin mainnet (genesis-hash-keyed, canonical, immutable).
// Used to gate BTC-only behavior — the cached btc-account-manager and the
// per-scriptType lazy derive only apply to BTC. Comparing against this
// constant is durable across renames of `ChainDef.id`; matches the same
// constant defined in sweep-engine.ts and rest-sweep.ts.
const BTC_NETWORK_ID = 'bip122:000000000019d6689c085ae165831e93'
const isBitcoin = (c: ChainDef) => c.networkId === BTC_NETWORK_ID

// isNativeDepositCaip lives in swap-parsing.ts (single source of truth — the
// quote parser and this build path MUST agree on what's a MsgDeposit, or one
// throws "missing inbound address" while the other would have built fine).

// CAIP namespace parser is shared with the picker so a future namespace
// addition (Solana SPL, etc.) only needs editing in one place.
import { parseCaip } from '../shared/swap-discovery'
import {
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  normalizeSlippageBps,
} from '../shared/slippage'

/** True for ERC-20 / BEP-20 / TRC-20 token sources. */
function isTokenCaip(caip: string): boolean {
  return parseCaip(caip).isToken
}

/** Extract the contract/token address from a CAIP-19, or null for native
 *  assets. Returns the raw form (CAIP preserves source case — EVM lowercase,
 *  Tron base58 case-sensitive). Caller is responsible for case normalization. */
function extractContractFromCaip(caip: string): string | null {
  return parseCaip(caip).contractAddress ?? null
}

/** Debug log — gated behind SWAP_DEBUG=1 (env) or localStorage `swap.debug=1`.
 *  Used in place of console.log for high-volume per-swap chatter. console.warn /
 *  console.error are deliberately *not* gated — those still ship in prod. */
const SWAP_DEBUG = ((): boolean => {
  try {
    if (typeof process !== 'undefined' && process.env?.SWAP_DEBUG === '1') return true
    if (typeof localStorage !== 'undefined' && localStorage.getItem('swap.debug') === '1') return true
  } catch { /* noop */ }
  return false
})()
const swapLog = (...args: any[]): void => { if (SWAP_DEBUG) console.log(...args) }

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** Format a bigint wei value as a human-readable string (avoids Number() precision loss for large values) */
function formatWei(wei: bigint, decimals = 18): string {
  const whole = wei / 10n ** BigInt(decimals)
  const frac = wei % 10n ** BigInt(decimals)
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '')
  return fracStr ? `${whole}.${fracStr}` : `${whole}`
}

/** Chain-aware minimum gas price floors (gwei) — enforced even when RPC/Pioneer report lower.
 *  L2s and less-used chains frequently report unrealistically low fees that cause mempool drops.
 *  ETH mainnet floor raised from 1 → 3: 1 gwei txs sit in mempool on busy days and time out.
 *  L2 floors raised so legacy-gas fallback path doesn't ship sub-base-fee txs. */
const MIN_GAS_GWEI: Record<string, number> = {
  ethereum: 3,
  polygon: 30,
  avalanche: 25,
  bsc: 3,
  base: 0.05,        // L2 base fees are sub-gwei; floor still must beat them
  arbitrum: 0.1,
  optimism: 0.05,
  gnosis: 2,
  monad: 50,
  hyperliquid: 0.1,
}

/** Chain-aware gas limits for depositWithExpiry — L2s need more for L1 data posting */
const DEPOSIT_GAS_LIMITS: Record<string, bigint> = {
  ethereum: 120000n,
  polygon: 120000n,
  avalanche: 120000n,
  bsc: 120000n,
  base: 200000n,
  arbitrum: 300000n,  // Arbitrum gas units != mainnet gas units
  optimism: 200000n,
}

// Router/inbound-address validation belongs in pioneer-router (which runs
// each integration's own checks before returning a quote). The vault trusts
// the router string Pioneer hands back. Kept here as a comment so future
// readers don't reintroduce a redundant check on the client side.

// ── Pool/Asset fetching via Pioneer ─────────────────────────────────

let assetCache: SwapAsset[] = []
let assetCacheTime = 0
const ASSET_CACHE_TTL = 5 * 60_000 // 5 minutes

/** Invalidate the asset cache (e.g., after Pioneer reconnects) */
export function clearSwapCache(): void {
  assetCache = []
  assetCacheTime = 0
}

/** Search Pioneer's full asset discovery database (not just swap-pool tokens).
 *  Uses the SearchAssets swagger operation (/discovery/search).
 *  Returns SwapAsset[] so the frontend can show them with assessAvailability. */
export async function searchDiscoveryAssets(query: string): Promise<SwapAsset[]> {
  const pioneer = await getPioneer()
  let resp: any
  try {
    resp = await pioneer.SearchAssets({ q: query, limit: 30 })
  } catch (e: any) {
    console.warn(`[swap] SearchAssets failed: ${e.message}`)
    return []
  }
  const results: any[] = resp?.data ?? []
  const assets: SwapAsset[] = []
  for (const item of results) {
    const caip: string = item.assetId
    if (!caip) continue
    const chainCaip2: string = item.chainId
    if (!chainCaip2) continue
    const chain = CHAINS.find(c => c.networkId === chainCaip2)
    if (!chain) continue
    const slashIdx = caip.indexOf('/')
    const tokenPart = slashIdx >= 0 ? caip.slice(slashIdx + 1) : ''
    const contractAddress = tokenPart.startsWith('erc20:') ? tokenPart.slice(6)
      : tokenPart.startsWith('token:') ? tokenPart.slice(6)
      : tokenPart.startsWith('bep20:') ? tokenPart.slice(6)
      : undefined
    assets.push({
      asset: `${chain.id.toUpperCase()}.${item.symbol}`,
      chainId: chain.id,
      symbol: item.symbol,
      name: item.name,
      chainFamily: chain.chainFamily,
      decimals: typeof item.precision === 'number' ? item.precision : chain.decimals,
      caip,
      contractAddress,
      icon: item.icon,
    })
  }
  return assets
}

/** Fetch available swap assets from Pioneer GetAvailableAssets */
export async function getSwapAssets(): Promise<SwapAsset[]> {
  if (assetCache.length > 0 && Date.now() - assetCacheTime < ASSET_CACHE_TTL) {
    return assetCache
  }

  const pioneer = await getPioneer()
  swapLog(`${TAG} Fetching available swap assets from Pioneer...`)

  const resp = await pioneer.GetAvailableAssets()
  const assets = parseAssetsResponse(resp)

  // Ensure RUNE is always included (may not be in pools list)
  if (!assets.find(a => a.asset === 'THOR.RUNE')) {
    const thorDef = CHAINS.find(c => c.id === 'thorchain')
    if (thorDef) {
      assets.unshift({
        asset: 'THOR.RUNE',
        chainId: 'thorchain',
        symbol: 'RUNE',
        name: 'THORChain',
        chainFamily: 'cosmos',
        decimals: 8,
        caip: thorDef.caip,
      })
    }
  }

  // Pioneer's /swap/available-assets historically omitted TRON entirely
  // even though /quote happily quotes TRON.TRX and TRON.USDT-TR7N... via
  // THORChain (both pools verified Available against thornode). Pioneer PR
  // #37 fixed this for both, but if a future deploy re-includes only one
  // (different whitelist policy, drift, etc.) the all-or-nothing shim
  // below would silently drop the other. Check each asset independently
  // so partial pioneer coverage doesn't regress us. Same posture as the
  // THOR.RUNE entry above.
  const tronDef = CHAINS.find(c => c.id === 'tron')
  if (tronDef) {
    if (!assets.find(a => a.asset === 'TRON.TRX')) {
      assets.push({
        asset: 'TRON.TRX',
        chainId: 'tron',
        symbol: 'TRX',
        name: 'Tron',
        chainFamily: 'tron',
        decimals: 6,
        caip: tronDef.caip,
      })
    }
    if (!assets.find(a => a.asset === 'TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T')) {
      assets.push({
        asset: 'TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T',
        chainId: 'tron',
        symbol: 'USDT',
        name: 'Tether (TRON)',
        chainFamily: 'tron',
        decimals: 6,
        contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        caip: 'tron:0x2b6653dc/token:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      })
    }
  }

  // THORChain bank tokens TCY and RUJI have live THORChain pools (THOR.TCY,
  // THOR.RUJI verified against thornode) but aren't always in Pioneer's
  // available-assets list. Same defensive shim as RUNE/TRON above — keyed by
  // their `/denom:` caip so the quote path routes them via THORChain.
  //
  // contractAddress = the bank denom: SwapDialog keys token-vs-native balance on
  // contractAddress (matched against the portfolio token's contractAddress,
  // which getBalances sets to the denom). WITHOUT it these fall through to the
  // native RUNE balance, so max/validation/price would quote against RUNE.
  const thorBankDef = CHAINS.find(c => c.id === 'thorchain')
  if (thorBankDef) {
    if (!assets.find(a => a.asset === 'THOR.TCY')) {
      assets.push({
        asset: 'THOR.TCY', chainId: 'thorchain', symbol: 'TCY', name: 'TCY',
        chainFamily: 'cosmos', decimals: 8, contractAddress: 'tcy',
        caip: 'cosmos:thorchain-mainnet-v1/denom:tcy',
      })
    }
    if (!assets.find(a => a.asset === 'THOR.RUJI')) {
      assets.push({
        asset: 'THOR.RUJI', chainId: 'thorchain', symbol: 'RUJI', name: 'Rujira',
        chainFamily: 'cosmos', decimals: 8, contractAddress: 'x/ruji',
        caip: 'cosmos:thorchain-mainnet-v1/denom:x/ruji',
      })
    }
  }

  swapLog(`${TAG} Loaded ${assets.length} swap assets from Pioneer`)
  assetCache = assets
  assetCacheTime = Date.now()
  return assets
}

// ── Quote fetching via Pioneer ──────────────────────────────────────

/** Fetch a swap quote from Pioneer (aggregated across DEXes) */
export async function getSwapQuote(params: SwapQuoteParams): Promise<SwapQuote> {
  if (!params.amount || parseFloat(params.amount) <= 0) {
    throw new Error('Amount must be greater than 0')
  }

  // Slippage policy: 0 is rejected (no protection = funds at risk on any
  // volatile pair). Anything outside [10, 5000] bps is clamped to that range.
  // Default to 100 bps (1%) when caller omits the field.
  if (params.slippageBps === 0) {
    throw new Error(
      `Slippage of 0 is not allowed — choose a tolerance between ` +
      `${MIN_SLIPPAGE_BPS / 100}% and ${MAX_SLIPPAGE_BPS / 100}%`,
    )
  }
  const slippageBps = params.slippageBps == null
    ? DEFAULT_SLIPPAGE_BPS
    : normalizeSlippageBps(params.slippageBps)

  const pioneer = await getPioneer()

  // Pioneer Quote takes CAIP directly — no THORChain-asset round-trip needed.
  // The legacy `fromAsset` / `toAsset` strings are still carried for tracking
  // + display, but vault no longer parses them to derive identity.
  const sellCaip = params.fromCaip
  const buyCaip = params.toCaip
  const slippage = slippageBps / 100 // Pioneer uses % not bps

  // Normalize BCH CashAddr: strip "bitcoincash:" prefix — THORChain uses short form
  const normalizeBchAddr = (addr: string) =>
    addr.startsWith('bitcoincash:') ? addr.slice('bitcoincash:'.length) : addr
  const senderAddress = normalizeBchAddr(params.fromAddress)
  const recipientAddress = normalizeBchAddr(params.toAddress)

  swapLog(`${TAG} Fetching quote: ${params.fromCaip} → ${params.toCaip} (${params.amount})`)
  swapLog(`${TAG} CAIP: ${sellCaip} → ${buyCaip}`)
  swapLog(`${TAG} sender=${senderAddress}, recipient=${recipientAddress}`)

  let quoteResp: any
  try {
    quoteResp = await pioneer.Quote({
      sellAsset: sellCaip,
      sellAmount: params.amount, // Pioneer expects DECIMAL format (human-readable)
      buyAsset: buyCaip,
      recipientAddress,
      senderAddress,
      slippage,
    })
  } catch (e: any) {
    // Pioneer-client (swagger-client) throws Error with message="Internal
    // Server Error" but the real diagnostic from THORNode (e.g. "amount less
    // than min swap amount (recommended_min_amount_in: …)") is in
    // e.response.body.message. Surface the inner message so the RPC layer +
    // frontend can render something useful instead of "Internal Server Error".
    const inner = e?.response?.body?.message || e?.responseError?.message || e?.response?.text
    if (inner && typeof inner === 'string') {
      // The text body comes through as a JSON string on some swagger versions;
      // try to unwrap once if it looks like JSON.
      let unwrapped = inner
      try {
        const parsed = JSON.parse(inner)
        if (parsed?.message) unwrapped = parsed.message
      } catch { /* not JSON, use as-is */ }
      const err = new Error(unwrapped)
      ;(err as any).cause = e
      throw err
    }
    throw e
  }

  // Log raw response structure for debugging quote parsing issues
  const qDebug = quoteResp?.data?.data || quoteResp?.data || quoteResp
  const firstQuote = Array.isArray(qDebug) ? qDebug[0] : qDebug
  swapLog(`${TAG} Raw quote response keys: ${firstQuote ? Object.keys(firstQuote).join(', ') : 'EMPTY'}`)

  // Pass the validated/clamped slippageBps so parseQuoteResponse's fallback
  // calc lines up with what was actually requested upstream.
  const result = parseQuoteResponse(quoteResp, { ...params, slippageBps })
  // Surface the underlying protocol when the integration is an aggregator
  // (e.g. ShapeShift → Relay/Thorchain/0x). Falls back to integration name.
  const route = result.swapper && result.swapper.toLowerCase() !== (result.integration || '').toLowerCase()
    ? `${result.swapper} via ${result.integration}`
    : (result.integration || 'unknown')
  swapLog(`${TAG} Quote: ${result.expectedOutput} (${route}), memo=${result.memo || 'NONE'}, router=${result.router || 'NONE'}, expiry=${result.expiry}`)

  // ── Refund-risk boundaries (every route) ──────────────────────────────
  // A protocol refunds when the emitted amount lands below the memo's price
  // limit — and the refund itself burns another outbound fee (observed:
  // $17.76 BTC→ETH came back as $14.52). Two unit-safe gates at quote time:
  //
  // 1. Fees eating the slippage allowance. totalBps is basis points across
  //    every integration. If quoted fees >= the slippage tolerance, the swap
  //    only completes when the price moves in our favor during confirmation —
  //    on small amounts the fixed outbound fee guarantees a refund instead.
  const feeBps = Number(result.fees?.totalBps) || 0
  if (feeBps >= slippageBps) {
    throw new Error(
      `Swap amount too low: quoted fees (${(feeBps / 100).toFixed(2)}%) meet or exceed the ` +
      `slippage allowance (${(slippageBps / 100).toFixed(2)}%), so the protocol would refund ` +
      `this swap on-chain — minus another network fee. Increase the amount or choose Custom ` +
      `slippage above ${(feeBps / 100).toFixed(2)}%.`
    )
  }
  // 2. Route-declared minimum sell amount — enforced for ALL integrations
  //    (previously only the NEAR Intents block checked it, so THORChain
  //    routes sailed past their recommended_min_amount_in).
  if (result.minAmountIn && parseFloat(params.amount) < parseFloat(result.minAmountIn)) {
    throw new Error(
      `Amount below this route's minimum (~${result.minAmountIn}). ` +
      `Smaller deposits are systematically refunded after fees.`
    )
  }

  // NEAR Intents: solver-network minimum amount check for ALL source chains.
  // Solvers must front the destination-chain gas and wait for source confirmations;
  // amounts below their profitability floor are systematically refunded.
  //
  // Two guards:
  //   A) BTC→EVM: explicit minAmountIn field from the quote.
  //   B) EVM→* deposit-channel: relay.value >> requested amount means the provider
  //      returned its minimum (not the user's amount). Detect and throw early so the
  //      user sees "too small" at quote time instead of "insufficient balance" at build.
  if (result.swapper === 'NEAR Intents') {
    if (params.fromCaip.startsWith('bip122:') || params.fromCaip.startsWith('solana:')) {
      // ── Refund-address safety validation (two independent layers) ──────────────
      // A confirmed fund loss occurred when 1Click was given keepkey.near as the
      // refundTo address instead of the user's BTC address (commit 4d748b82).
      // We now verify the refundTo from both Pioneer's response AND directly from
      // the 1Click API before the user ever sees the Confirm button.

      // bip122 (BTC/ZEC/DOGE) and solana addresses are case-sensitive base58 —
      // never lowercase them. EVM is not in this branch.
      const senderAddr = params.fromAddress?.trim()
      // BCH cashaddr can appear with or without the "bitcoincash:" prefix — Pioneer/1Click
      // strips it, so normalize both sides before comparing (same pattern as lines ~234, ~505).
      const stripBchPrefix = (a: string | undefined) =>
        a?.startsWith('bitcoincash:') ? a.slice('bitcoincash:'.length) : a
      const senderAddrNorm = stripBchPrefix(senderAddr)
      const depositAddr = result.inboundAddress || result.nearIntentsDepositAddress

      // Layer 1: Pioneer's parsed refundTo must exist and match senderAddress.
      const pioneerRefundTo = result.nearIntentsRefundTo?.trim()
      if (!pioneerRefundTo) {
        throw new Error(
          'NEAR Intents quote is missing refundTo — cannot verify refund safety. ' +
          'Do not proceed: if the swap fails, funds may go to an uncontrolled address.'
        )
      }
      if (senderAddrNorm && stripBchPrefix(pioneerRefundTo) !== senderAddrNorm) {
        throw new Error(
          `NEAR Intents refundTo mismatch — Pioneer registered "${result.nearIntentsRefundTo}" ` +
          `as refund address but your wallet address is "${params.fromAddress}". ` +
          `Do not proceed: a refund would not return to your wallet.`
        )
      }
      swapLog(`${TAG} NEAR Intents Layer 1 OK: refundTo=${result.nearIntentsRefundTo} matches senderAddress`)

      // Layer 2: Independently verify refundTo by calling 1Click directly.
      // This does not trust Pioneer — it reads the intent that NEAR Intents
      // actually created. A 404 means the deposit address wasn't registered with
      // 1Click (different fund-loss path) — also blocked.
      if (depositAddr) {
        try {
          const oneClickResp = await fetch(
            `https://1click.chaindefuser.com/v0/status?depositAddress=${encodeURIComponent(depositAddr)}`,
            { signal: AbortSignal.timeout(8000) },
          )
          if (!oneClickResp.ok) {
            throw new Error(
              `NEAR Intents: 1Click returned ${oneClickResp.status} for deposit address — ` +
              `cannot verify refund address. Do not proceed.`
            )
          }
          const oneClickData = await oneClickResp.json() as any
          const oneClickRefundTo = (oneClickData?.quoteResponse?.quoteRequest?.refundTo as string | undefined)?.trim()
          if (!oneClickRefundTo) {
            throw new Error(
              'NEAR Intents: 1Click response missing quoteRequest.refundTo — cannot verify refund safety.'
            )
          }
          if (senderAddrNorm && stripBchPrefix(oneClickRefundTo) !== senderAddrNorm) {
            throw new Error(
              `NEAR Intents 1Click refundTo mismatch — 1Click has "${oneClickData?.quoteResponse?.quoteRequest?.refundTo}" ` +
              `but your wallet address is "${params.fromAddress}". ` +
              `Do not proceed: a refund would not return to your wallet.`
            )
          }
          swapLog(`${TAG} NEAR Intents Layer 2 OK: 1Click refundTo=${oneClickData?.quoteResponse?.quoteRequest?.refundTo} matches senderAddress`)
        } catch (e: any) {
          if (e.message.startsWith('NEAR Intents')) throw e
          throw new Error(`NEAR Intents: failed to verify refund address with 1Click API: ${e.message}`)
        }
      }
      // ─────────────────────────────────────────────────────────────────────────

      // BTC source: explicit minimum check
      if (result.minAmountIn && parseFloat(params.amount) < parseFloat(result.minAmountIn)) {
        throw new Error(
          `Amount too small for NEAR Intents — minimum ${result.minAmountIn} BTC required. ` +
          `Solvers must front ETH and wait for BTC confirmations; smaller amounts are unprofitable and will be refunded.`
        )
      }
      const nowSec = Math.floor(Date.now() / 1000)
      const minutesUntilExpiry = result.expiry ? (result.expiry - nowSec) / 60 : 0
      if (result.expiry && minutesUntilExpiry < 60) {
        console.warn(
          `${TAG} NEAR Intents BTC→EVM quote expires in ${minutesUntilExpiry.toFixed(0)} min — ` +
          `BTC requires 2 confirmations (20-40 min). If BTC doesn't confirm in time, swap will be refunded.`
        )
      }
    }

    // EVM/non-BTC deposit-channel: detect when relay.value >> requested amount.
    // NEAR Intents returns its solver minimum when the user's amount is too small.
    // relay.value is in native-chain base units (wei for ETH).
    if (result.relayTx?.isDepositChannel && result.relayTx?.value && !parseCaip(params.fromCaip).isToken) {
      const ns = params.fromCaip.split('/')[0]
      const srcDecimals = ns.startsWith('eip155:') ? 18 : ns.startsWith('solana:') ? 9 : 6
      const requestedBaseUnits = params.amount ? parseUnits(params.amount, srcDecimals) : 0n
      if (requestedBaseUnits > 0n) {
        const quotedBaseUnits = BigInt(result.relayTx.value)
        // If quoted deposit is >20% above requested, Pioneer returned the provider's
        // minimum (not the user's amount). Throw before build so the error lands at
        // quote time, not "insufficient balance" at sign time.
        if (quotedBaseUnits > requestedBaseUnits * 12n / 10n) {
          const minHuman = formatWei(quotedBaseUnits, srcDecimals)
          throw new Error(
            `Amount too small for NEAR Intents — minimum deposit on this route is ~${minHuman}. ` +
            `Increase the swap amount or choose a different route.`
          )
        }
      }
    }
  }

  return result
}

// ── Swap execution ──────────────────────────────────────────────────

/** Wallet methods used during swap execution (subset of hdwallet interface) */
export interface SwapWallet {
  getPublicKeys(params: any[]): Promise<Array<{ xpub: string }> | null>
  ethSignTx(params: any): Promise<any>
  [method: string]: (...args: any[]) => Promise<any>  // dynamic address/sign methods
}

/** Dependencies injected by the caller (index.ts) to avoid circular imports */
/** Substage of executeSwap. The frontend's coarse phase ('approving' /
 *  'signing' / 'broadcasting') stays the same; this finer-grained value is a
 *  separate UI signal so the "Approving token… 1/2" label can become
 *  "Broadcasting approval…" / "Sign swap on device" etc. as the flow
 *  progresses. Without this, ERC-20 swaps display "Approving token… 1/2"
 *  for the entire executeSwap including the swap signing step (retro #1). */
export type SwapSubStage =
  | 'approve-signing'         // device prompting for ERC-20 approve
  | 'approve-broadcasting'    // approve tx going to mempool
  | 'approve-waiting-receipt' // waiting for approve to confirm
  | 'swap-signing'            // device prompting for the swap itself
  | 'swap-broadcasting'       // swap tx going to mempool

export interface SwapContext {
  wallet: SwapWallet
  getAllChains: () => ChainDef[]
  getRpcUrl: (chain: ChainDef) => string | undefined
  getBtcXpub: () => { xpub: string; scriptType: string; accountPath?: number[] } | undefined  // selected BTC xpub + account metadata
  getAllBtcXpubs: () => Array<{ xpub: string; scriptType: string; accountPath: number[] }>  // all funded BTC xpubs
  /** Wrap signing ops for emulator (shows confirm UI). Pass-through on real device. */
  wrapSign: (fn: () => Promise<any>, details: { operation: string; chain?: string; to?: string; value?: string; memo?: string }) => Promise<any>
  /** Push a finer-grained substage label to the UI. Required (use NOOP_PUSH_SUBSTAGE
   *  for REST/headless callers) so a future entry point can't silently regress
   *  the UI to a coarse phase by forgetting to wire it up. */
  pushSubStage: (stage: SwapSubStage) => void
  /** Whether the device's AdvancedMode (blind-signing) policy is enabled.
   *  Returns undefined when unknown (no cached features / policy not reported).
   *  Used to gate Solana swaps, which can only blind-sign. */
  isAdvancedModeEnabled?: () => boolean | undefined
  /** User's configured Solana RPC, for the host-side outflow check. */
  getSolanaRpcEndpoint?: () => string | undefined
  /** Durable ClearSign evidence sink owned by Vault (no-op for callers that do not persist). */
  onClearSignEvent?: (event: {
    outcome: 'signed' | 'blocked'
    chain: string
    format: string
    label: string
    payload: string
    keyId?: number
    sentToDevice: boolean
    request?: Record<string, unknown>
    error?: string
  }) => void
}

/** Sentinel no-op for SwapContext.pushSubStage in REST/headless paths. */
export const NOOP_PUSH_SUBSTAGE = (_stage: SwapSubStage): void => { /* intentional no-op */ }

/** Execute a swap: build tx, sign on device, broadcast */
export async function executeSwap(params: ExecuteSwapParams, ctx: SwapContext): Promise<SwapResult> {
  const { wallet, getAllChains, getRpcUrl, getBtcXpub, getAllBtcXpubs, wrapSign, pushSubStage, onClearSignEvent } = ctx
  const stage = (s: SwapSubStage) => { try { pushSubStage(s) } catch { /* never block on push */ } }

  // Resolve source chain
  const allChains = getAllChains()
  const fromChain = allChains.find(c => c.id === params.fromChainId)
  if (!fromChain) throw new Error(`Unknown source chain: ${params.fromChainId}`)

  // CAIP-driven: '/erc20:' / '/bep20:' namespaces are tokens; '/slip44:' is native.
  const isErc20Source = isTokenCaip(params.fromCaip) && fromChain.chainFamily === 'evm'

  // 1. Get sender address (use override if provided, otherwise derive from path)
  let fromAddress = params.fromAddressOverride
  if (!fromAddress) {
    const fromPath = fromChain.chainFamily === 'evm' && params.fromEvmAddressIndex != null
      ? evmAddressPath(params.fromEvmAddressIndex)
      : fromChain.defaultPath
    const addrParams: any = {
      addressNList: fromPath,
      showDisplay: false,
      coin: fromChain.chainFamily === 'evm' ? 'Ethereum' : fromChain.coin,
    }
    if (fromChain.scriptType) addrParams.scriptType = fromChain.scriptType
    const addrMethod = fromChain.id === 'ripple' ? 'rippleGetAddress' : fromChain.rpcMethod
    const addrResult = await wallet[addrMethod](addrParams)
    fromAddress = typeof addrResult === 'string' ? addrResult : addrResult?.address
  }
  if (!fromAddress) throw new Error('Could not derive sender address')

  // 1b. Derive destination address for validation
  const toChain = allChains.find(c => c.id === params.toChainId)
  if (!toChain) throw new Error(`Unknown destination chain: ${params.toChainId}`)

  let toAddress = params.toAddressOverride
  if (!toAddress) {
    const toAddrParams: any = {
      addressNList: toChain.defaultPath,
      showDisplay: false,
      coin: toChain.chainFamily === 'evm' ? 'Ethereum' : toChain.coin,
    }
    if (toChain.scriptType) toAddrParams.scriptType = toChain.scriptType
    const toAddrMethod = toChain.id === 'ripple' ? 'rippleGetAddress' : toChain.rpcMethod
    const toAddrResult = await wallet[toAddrMethod](toAddrParams)
    toAddress = typeof toAddrResult === 'string' ? toAddrResult : toAddrResult?.address
  }
  if (!toAddress) throw new Error('Could not derive destination address')

  // SAFETY: Reject memos containing extended pubkeys — these are never valid destinations
  // and indicate the quote was fetched with an unresolved xpub address.
  // Covers: xpub/ypub/zpub (BTC), dgub (DOGE), Ltub/Mtub (LTC), drkp/drks (DASH), tpub (testnet)
  if (params.memo && /(xpub|ypub|zpub|dgub|Ltub|Mtub|drkp|drks|tpub|upub|vpub)[a-zA-Z0-9]{20,}/.test(params.memo)) {
    throw new Error('Swap memo contains an extended pubkey instead of a destination address — aborting to protect funds')
  }

  // Validate the memo contains our destination address (only for UTXO/Cosmos — EVM memos use shorthand/aggregator formats)
  // Normalize BCH CashAddr: strip "bitcoincash:" prefix for comparison — THORChain memos use short form
  const toAddrNorm = toAddress.startsWith('bitcoincash:') ? toAddress.slice('bitcoincash:'.length) : toAddress
  if (params.memo && fromChain.chainFamily !== 'evm' && !params.memo.toLowerCase().includes(toAddrNorm.toLowerCase())) {
    console.warn(`${TAG} WARNING: Swap memo does not contain derived destination address. Memo may use a different format.`)
  }

  // 2. Validate required fields
  // Calldata-based integrations (relay, shapeshiftSwap, …) ship the full
  // tx in `relayTx` — no memo or inbound address needed. Anything else is
  // memo+vault-routed (THORChain/Maya).
  const hasPrebuiltTx = !!params.relayTx
  // Native THORChain/Maya deposits (RUNE, CACAO) use MsgDeposit — no inbound vault needed
  const isNativeDeposit = isNativeDepositCaip(params.fromCaip)
  const fromIsUtxo = params.fromCaip.startsWith('bip122:')
  const fromIsSolana = params.fromCaip.startsWith('solana:')
  const isMemolessTransfer = (fromIsUtxo || fromIsSolana) && !!params.inboundAddress && !params.memo
  if (!params.inboundAddress && !isNativeDeposit && !hasPrebuiltTx) throw new Error('Missing inbound vault address from quote')
  if (!params.memo && !hasPrebuiltTx && !isMemolessTransfer) throw new Error('Missing swap memo from quote')
  assertSwapMemoFitsSource(params.memo, params.fromCaip)

  swapLog(`${TAG} Executing: ${params.fromCaip} → ${params.toCaip}, amount=${params.amount}`)
  if (hasPrebuiltTx) {
    swapLog(`${TAG} ${params.integration} — using pre-built tx (to=${params.relayTx!.to}, chainId=${params.relayTx!.chainId})`)
  } else {
    swapLog(`${TAG} Chain family: ${fromChain.chainFamily}, vault: ${params.inboundAddress || 'MsgDeposit'}, router: ${params.router || 'none'}`)
  }
  if (isErc20Source) swapLog(`${TAG} ERC-20 source detected: ${params.fromCaip}`)

  // 3. Get Pioneer for tx building
  const pioneer = await getPioneer()

  let unsignedTx: any
  let approvalTxid: string | undefined
  let fromAmountBaseUnits: string | undefined

  // ── Calldata integrations (relay, shapeshiftSwap, …): sign prebuilt tx ──
  if (hasPrebuiltTx) {
    // Relay Solana bridge: serializedTx is already a fully-assembled Solana wire tx.
    // Skip the EVM-only buildRelaySwapTx and feed it straight to the Solana signer.
    if (fromChain.chainFamily === 'solana' && params.relayTx?.serializedTx) {
      swapLog(`${TAG} Relay Solana prebuilt tx — bypassing EVM relay builder`)
      // A signed KKSOLSC1 schema lets the device decode this instruction —
      // program, amount, destination — instead of showing a blind-sign prompt.
      // findSolanaSchema declines when the message still carries lookup
      // tables, since firmware will not apply a schema to accounts that are
      // absent from the signed bytes.
      const solSchema = findSolanaSchema(params.relayTx.serializedTx)
      if (solSchema) {
        swapLog(`${TAG} clear-sign schema attached: ${solSchema.program}/${solSchema.instruction} (keyId=${solSchema.signerKeyId})`)
      }
      unsignedTx = {
        addressNList: fromChain.defaultPath,
        rawTx: params.relayTx.serializedTx,
        allowBlindSigning: params.allowSolanaBlindSigning === true,
        swapMetadata: params.relayTx.solanaSwapMetadata,
        ...(solSchema
          ? { schema: { payload: solSchema.payload, signature: solSchema.signature, signerKeyId: solSchema.signerKeyId } }
          : {}),
      }
    } else if (fromChain.chainFamily === 'tron') {
      // Tron has no nonces — buildRelaySwapTx is EVM-only. Route through TronGrid txbuilder.
      swapLog(`${TAG} Relay Tron prebuilt tx — bypassing EVM relay builder`)
      const knownAssets = await getSwapAssets()
      const fromAssetMeta = knownAssets.find(a => a.caip === params.fromCaip)
      const buildResult = await txb.buildTx(pioneer, fromChain, {
        chainId: fromChain.id,
        to: params.relayTx!.to || params.inboundAddress,
        amount: params.amount, memo: params.memo || '', feeLevel: params.feeLevel, isMax: params.isMax,
        isSwapDeposit: true, fromAddress,
        caip: fromAssetMeta?.caip ?? params.fromCaip, tokenDecimals: fromAssetMeta?.decimals ?? params.tokenDecimals,
      })
      unsignedTx = buildResult.unsignedTx
    } else {
      const result = await buildRelaySwapTx(params, fromChain, fromAddress, getRpcUrl, isErc20Source, /* previewMode */ false)
      unsignedTx = result.unsignedTx
      fromAmountBaseUnits = result.fromAmountBaseUnits

      // ERC-20 relay txs may need an approval to the router (THORChain Router,
      // 0x exchange proxy, etc.) — without it the router's transferFrom call
      // reverts on-chain. Same pattern as buildEvmSwapTx but driven from here.
      if (result.approveTx) {
        swapLog(`${TAG} Relay ERC-20 approval required: prompting device for approveTx`)
        stage('approve-signing')
        const signedApprove = await wallet.ethSignTx(result.approveTx)
        swapLog(`${TAG} Device signed approveTx`)
        let approveHex: string = typeof signedApprove === 'string'
          ? signedApprove
          : (signedApprove?.serializedTx || signedApprove?.serialized || '')
        if (!approveHex) throw new Error('Failed to extract serialized approve tx (relay path)')
        if (!approveHex.startsWith('0x')) approveHex = '0x' + approveHex
        const rpcUrl = getRpcUrl(fromChain)
        stage('approve-broadcasting')
        if (rpcUrl) {
          approvalTxid = await broadcastEvmTx(rpcUrl, approveHex, fromAddress)
          swapLog(`${TAG} Relay-path approve broadcast: ${approvalTxid}`)
          stage('approve-waiting-receipt')
          const receipt = await waitForTxReceipt(rpcUrl, approvalTxid, 180_000)
          if (receipt && !receipt.status) {
            throw new Error(`Relay-path ERC-20 approve reverted (txid: ${approvalTxid}). Swap aborted — no relay tx sent.`)
          }
          if (!receipt) console.warn(`${TAG} Relay-path approve receipt not confirmed in 180s — proceeding (nonce gap risk)`)
        } else {
          const approveResult = await pioneer.Broadcast({ networkId: fromChain.networkId, serialized: approveHex })
          approvalTxid = approveResult?.data?.txid || approveResult?.data?.tx_hash || approveResult?.data?.hash
          swapLog(`${TAG} Relay-path approve broadcast (Pioneer): ${approvalTxid}`)
        }
      }
    }

  // ── EVM chains: MUST use router contract depositWithExpiry() ──
  } else if (fromChain.chainFamily === 'evm') {
    const result = await buildEvmSwapTx(params, fromChain, fromAddress, pioneer, getRpcUrl, isErc20Source, wallet, /* previewMode */ false, stage)
    unsignedTx = result.unsignedTx
    approvalTxid = result.approvalTxid

  // ── UTXO chains: send to vault, memo in OP_RETURN ──
  } else if (fromChain.chainFamily === 'utxo') {
    let xpub: string | undefined
    let scriptTypeOverride: string | undefined
    let accountPath: number[] | undefined
    let allXpubs: Array<{ xpub: string; scriptType: string; accountPath: number[] }> | undefined

    if (isBitcoin(fromChain)) {
      // BTC: aggregate UTXOs from every device-supported account type.
      try {
        allXpubs = getAllBtcXpubs()
        if (allXpubs.length > 0) {
          swapLog(`${TAG} BTC multi-xpub: ${allXpubs.length} funded xpubs`)
          // Primary xpub for change address = selected, or first funded
          const btcInfo = getBtcXpub()
          xpub = btcInfo?.xpub || allXpubs[0].xpub
          scriptTypeOverride = btcInfo?.scriptType || allXpubs[0].scriptType
          accountPath = btcInfo?.accountPath || allXpubs[0].accountPath
        }
      } catch { /* BTC account manager not ready */ }
      if (!xpub) {
        // Fallback: single selected xpub
        try {
          const btcInfo = getBtcXpub()
          if (btcInfo) { xpub = btcInfo.xpub; scriptTypeOverride = btcInfo.scriptType; accountPath = btcInfo.accountPath }
        } catch {}
      }
      if (!xpub) {
        // Lazy-init: btcAccountManager hasn't been hydrated (user opened swap
        // without visiting BTC dashboard first). Derive every supported account
        // type; P2TR is included only when firmware advertises the capability.
        // Without this we'd fall through to the chain.scriptType fallback below
        // which is `p2pkh` (Legacy) and miss every modern wallet.
        const btcScriptTypes = await supportedBtcScriptTypes(wallet)
        const paths = btcScriptTypes.map(st => ({
          addressNList: btcAccountPath(st.purpose, 0),
          coin: 'Bitcoin',
          scriptType: st.scriptType,
          curve: 'secp256k1',
        }))
        const results = await wallet.getPublicKeys(paths)
        const derived: Array<{ xpub: string; scriptType: string; accountPath: number[] }> = []
        for (let i = 0; i < btcScriptTypes.length; i++) {
          const xp = results?.[i]?.xpub
          if (xp) derived.push({ xpub: xp, scriptType: btcScriptTypes[i].scriptType, accountPath: paths[i].addressNList })
        }
        if (derived.length > 0) {
          const native = derived.find(d => d.scriptType === 'p2wpkh') || derived[0]
          xpub = native.xpub
          scriptTypeOverride = native.scriptType
          accountPath = native.accountPath
          allXpubs = derived
          swapLog(`${TAG} BTC lazy-derive: ${derived.length} scriptTypes from device (primary=${native.scriptType})`)
        }
      }
    }
    if (!xpub) {
      try {
        const result = await wallet.getPublicKeys([{
          addressNList: fromChain.defaultPath.slice(0, 3),
          coin: fromChain.coin,
          scriptType: fromChain.scriptType,
          curve: 'secp256k1',
        }])
        xpub = result?.[0]?.xpub
      } catch (e: any) {
        throw new Error(`Failed to get xpub for ${fromChain.coin}: ${e.message}`)
      }
    }

    const buildResult = await txb.buildTx(pioneer, fromChain, {
      chainId: fromChain.id,
      to: params.inboundAddress,
      amount: params.amount,
      memo: params.memo,
      feeLevel: params.feeLevel,
      isMax: params.isMax,
      fromAddress,
      xpub,
      allXpubs,
      scriptTypeOverride,
      accountPath,
    })
    unsignedTx = buildResult.unsignedTx

    // NEAR Intents fail-fast: verify the deposit VOUT matches the quoted amount
    // before the device is ever asked to sign. params.amount is the amount 1Click
    // committed to receive; if the built tx delivers less, that's PARTIAL_DEPOSIT.
    // No network call needed — we already know both numbers locally.
    if ((params.swapper === 'NEAR Intents' || params.integration === 'nearIntents') && params.inboundAddress) {
      const outputs = unsignedTx.outputs as Array<{ address?: string; value: number }> | undefined
      // Normalize BCH addresses for comparison: buildUtxoTx may have converted
      // the legacy inboundAddress to cashaddr, so compare normalized forms.
      const normInbound = fromChain.id === 'bitcoincash'
        ? normalizeBchAddress(params.inboundAddress)
        : params.inboundAddress
      const depositOut = outputs?.find(o => o.address === normInbound)
      if (!depositOut || depositOut.value <= 0) {
        throw new Error(
          `NEAR Intents: deposit output to ${params.inboundAddress} not found in built tx — aborting to prevent fund loss`
        )
      }
      const quotedSat = Math.round(parseFloat(params.amount) * Math.pow(10, fromChain.decimals))
      if (quotedSat > 0 && quotedSat - depositOut.value > 1) {
        const shortfall = quotedSat - depositOut.value
        throw new Error(
          `NEAR Intents: deposit shortfall — tx delivers ${depositOut.value} sat but ` +
          `quote expects ${quotedSat} sat (short by ${shortfall} sat). ` +
          `Refresh the quote and try again.`
        )
      }
      swapLog(`[swap] NEAR Intents deposit verified: ${depositOut.value} sat (quote expects ${quotedSat} sat)`)
    }

  // ── All other chains (Cosmos, XRP, Solana, Tron, TON): send to vault with memo ──
  } else {
    // Resolve the canonical CAIP for the source asset and pull token decimals
    // from the cached SwapAsset list. Without this, buildTx's TRC-20 detection
    // (which keys off `params.caip` matching `tron:.../token:T...`) never
    // triggers for a USDT-on-TRON source — buildTx falls through to the native
    // TRX `createtransaction` path and would send `params.amount` as TRX to the
    // THORChain inbound address instead of as a USDT.transfer() call. Same
    // pattern would matter for any future SPL/non-EVM token sends.
    const knownAssets = await getSwapAssets()
    // CAIP-keyed lookup. Synthesized assets (picker selections Pioneer didn't
    // pre-list, e.g. SPL USDT — Pioneer's available-assets carries no SPL
    // tokens at all) won't be in knownAssets; fall back to the decimals the
    // picker asset carried. The SPL builder hard-throws when both are missing
    // rather than guessing — wrong decimals scale the send by 10^n.
    const fromAssetMeta = knownAssets.find(a => a.caip === params.fromCaip)
    const sourceCaip = fromAssetMeta?.caip ?? params.fromCaip
    const tokenDecimals = fromAssetMeta?.decimals ?? params.tokenDecimals

    const buildResult = await txb.buildTx(pioneer, fromChain, {
      chainId: fromChain.id,
      // MsgDeposit (RUNE/CACAO native swaps) ignores `to` — use sender as fallback
      to: params.inboundAddress || fromAddress,
      amount: params.amount,
      memo: params.memo,
      feeLevel: params.feeLevel,
      isMax: params.isMax,
      isSwapDeposit: true, // C1 fix: explicit flag for MsgDeposit (not inferred from memo)
      fromAddress,
      caip: sourceCaip,
      tokenDecimals,
      // MsgDeposit coins asset: THOR.RUNE for native, THOR.TCY/THOR.RUJI for
      // bank tokens. Without this the builder defaults to THOR.RUNE and the
      // network would try to take RUNE for a TCY/RUJI swap.
      depositAsset: fromAssetMeta?.asset,
    })
    unsignedTx = buildResult.unsignedTx
  }

  // Prebuilt Relay Solana payloads currently use a custom program plus
  // lookup-table accounts. Without a transaction-bound ClearSign descriptor the
  // device must classify that exact route as opaque. Ask for explicit one-shot
  // consent before the hardware prompt, but do not block other Solana or v0
  // transactions that firmware can natively ClearSign.
  const needsOpaqueSolanaFallback =
    fromChain.chainFamily === 'solana' &&
    !!params.relayTx?.serializedTx &&
    !params.relayTx.solanaSwapMetadata &&
    // A reusable schema lets the device read this instruction, so no
    // blind-sign consent is needed.
    !findSolanaSchema(params.relayTx.serializedTx)
  if (
    needsOpaqueSolanaFallback &&
    ctx.isAdvancedModeEnabled?.() !== true &&
    params.allowSolanaBlindSigning !== true
  ) {
    // The device can't verify this transaction, so check it here instead:
    // simulate against an independent RPC and report what actually leaves the
    // wallet. This catches a quote server that built a transaction differing
    // from the quote the user approved. It is NOT device verification — a
    // compromised host could fake it — so the UI must say "checked on this
    // computer", never "verified". Best-effort: a failed check reports
    // unknown and still requires explicit consent.
    let outflow: string | undefined
    try {
      const { checkSolanaOutflow } = await import('./solana-outflow')
      const { DEFAULT_SOLANA_RPC_ENDPOINT, createRpcAltFetcher } = await import('./solana-alt')
      const endpoint = ctx.getSolanaRpcEndpoint?.() || DEFAULT_SOLANA_RPC_ENDPOINT
      // For a token-source swap the SOL balance barely moves — the tokens are
      // what leave. Watch the source mint's accounts or the report is
      // misleadingly reassuring.
      const sourceMint = params.fromCaip?.includes('/token:')
        ? params.fromCaip.split('/token:')[1]
        : undefined
      const r = await checkSolanaOutflow(params.relayTx!.serializedTx!, fromAddress, sourceMint, endpoint)

      // Name WHY the device can't clear-sign this. Firmware has three
      // independent triggers (unknown program / lookup-table accounts /
      // unchecked SPL Transfer with no mint) and the generic "confirm this
      // transaction" prompt hides which one fired — so decode host-side and
      // say it out loud. Diagnostic only; never a security claim.
      let reason: string | undefined
      let decoded: string[] | undefined
      try {
        const { buildSolanaDecodedInfo } = await import('./solana-clearsign')
        const d = await buildSolanaDecodedInfo(params.relayTx!.serializedTx!, createRpcAltFetcher(endpoint))
        const unknownPrograms = d.instructions
          .filter(i => i.status === 'unknown-program')
          .map(i => i.programName || i.programId)
        const parts: string[] = []
        if (unknownPrograms.length) parts.push(`unrecognized program(s): ${[...new Set(unknownPrograms)].join(', ')}`)
        if (d.altPubkeys.length) parts.push(`${d.altPubkeys.length} lookup table(s)`)
        const uncheckedTransfer = d.instructions.some(
          i => /token/i.test(i.programName || '') && /^transfer$/i.test(i.instructionName || ''))
        if (uncheckedTransfer) parts.push('SPL Transfer without a mint (unchecked)')
        reason = parts.join('; ') || undefined

        // Programs in the registry decode fully — show the user what each
        // instruction actually does, which is the "amount and destination"
        // the device itself can't reach for these routes.
        decoded = d.instructions
          .filter(i => i.status === 'known')
          .map(i => {
            const amt = i.args.find(a => a.name === 'amount')?.value
            // Match the destination label EXACTLY. A loose /to\b/ also matches
            // "refundTo" — which is the sender's own address — and .find()
            // returns it first, so the panel showed you sending to yourself.
            const dest = i.accounts.find(a => /^(vault|destination|recipient)$/i.test(a.label || ''))?.pubkey
            return [
              `${i.programName}: ${i.instructionName}`,
              amt ? `amount ${amt}` : null,
              dest ? `→ ${dest.slice(0, 6)}…${dest.slice(-4)}` : null,
            ].filter(Boolean).join(' · ')
          })
        if (!decoded.length) decoded = undefined

        swapLog(`${TAG} opaque Solana tx — ${reason || 'reason undetermined'}; instructions: ` +
          d.instructions.map(i => `${i.programName || i.programId}/${i.instructionName || i.status}`).join(', '))
      } catch (e: any) {
        swapLog(`${TAG} opaque-reason decode failed: ${e?.message}`)
      }

      // Decimals + symbol so the panel shows "100 USDT", not raw base units.
      // (This branch sits outside the builder block that resolves asset meta,
      // so look it up here rather than reaching for an out-of-scope binding.)
      const srcMeta = (await getSwapAssets()).find(a => a.caip === params.fromCaip)
      const srcDecimals = srcMeta?.decimals ?? params.tokenDecimals
      outflow = JSON.stringify({
        solAfter: r.solLamportsAfter.toString(),
        tokensAfter: r.tokensAfter.map(t => ({
          mint: t.mint,
          amount: t.amountAfter.toString(),
          decimals: srcDecimals,
          symbol: srcMeta?.symbol,
        })),
        spending: params.amount,
        spendingSymbol: srcMeta?.symbol,
        unavailable: r.unavailable,
        reason,
        decoded,
      })
    } catch (e: any) {
      swapLog(`${TAG} outflow check failed: ${e?.message}`)
    }
    throw new Error(outflow
      ? `${SOLANA_BLIND_SIGNING_REQUIRED} ${outflow}`
      : SOLANA_BLIND_SIGNING_REQUIRED)
  }

  // 4. Sign on device (user confirms tx details on hardware wallet)
  swapLog(`${TAG} Signing ${fromChain.chainFamily} tx via ${fromChain.signMethod}...`)
  stage('swap-signing')
  let signedTx: any
  const clearSignMaterial = unsignedTx?.schema?.payload
    ? {
        payload: String(unsignedTx.schema.payload),
        format: 'KKSOLSC1_BASE64',
        keyId: unsignedTx.schema.signerKeyId,
        label: `ClearSign ${fromChain.coin} swap`,
      }
    : unsignedTx?.txMetadata?.signedPayload
      ? {
          payload: unsignedTx.txMetadata.signedPayload instanceof Uint8Array
            ? Buffer.from(unsignedTx.txMetadata.signedPayload).toString('hex')
            : String(unsignedTx.txMetadata.signedPayload),
          format: 'EVM_TX_METADATA',
          keyId: unsignedTx.txMetadata.keyId,
          label: `ClearSign ${fromChain.coin} swap`,
        }
      : undefined
  const clearSignRequest = clearSignMaterial ? {
    fromCaip: params.fromCaip,
    toCaip: params.toCaip,
    integration: params.integration,
    swapper: params.swapper,
  } : undefined
  let clearSignSentToDevice = false
  try {
    signedTx = await wrapSign(
      () => {
        clearSignSentToDevice = true
        return txb.signTx(wallet, fromChain, unsignedTx)
      },
      { operation: 'swap', chain: fromChain.coin, to: params.inboundAddress, value: params.amount, memo: params.memo },
    )
    if (clearSignMaterial) onClearSignEvent?.({
      outcome: 'signed', chain: fromChain.coin, ...clearSignMaterial,
      keyId: Number.isInteger(clearSignMaterial.keyId) ? clearSignMaterial.keyId : undefined,
      sentToDevice: clearSignSentToDevice, request: clearSignRequest,
    })
  } catch (e: any) {
    // hdwallet throws the decoded protobuf Failure object, not an Error — log
    // and rethrow the unwrapped reason so it survives the RPC boundary.
    const reason = deviceErrorMessage(e)
    if (clearSignMaterial) onClearSignEvent?.({
      outcome: 'blocked', chain: fromChain.coin, ...clearSignMaterial,
      keyId: Number.isInteger(clearSignMaterial.keyId) ? clearSignMaterial.keyId : undefined,
      sentToDevice: clearSignSentToDevice, request: clearSignRequest,
      error: reason,
    })
    console.error(`${TAG} SIGN FAILED: ${reason}`)
    console.error(`${TAG}   chain=${fromChain.id}, method=${fromChain.signMethod}`)
    if (e instanceof Error && e.stack) console.error(`${TAG}   stack: ${e.stack.split('\n').slice(0, 5).join('\n')}`)
    throw toDeviceError(e)
  }
  swapLog(`${TAG} Sign complete, serialized=${!!signedTx?.serialized || !!signedTx?.serializedTx}`)

  // 5. Broadcast — prefer direct RPC for EVM chains (Pioneer relay can silently drop txs)
  stage('swap-broadcasting')
  let txid: string
  const swapRpcUrl = fromChain.chainFamily === 'evm' ? getRpcUrl(fromChain) : undefined
  if (swapRpcUrl && fromChain.chainFamily === 'evm') {
    // Extract serialized tx hex from signed result
    const serializedHex: string | undefined = typeof signedTx === 'string' ? signedTx
      : signedTx?.serializedTx || signedTx?.serialized
    if (!serializedHex) {
      throw new Error(`Cannot extract serialized tx from signed result: ${JSON.stringify(signedTx).slice(0, 200)}`)
    }
    try {
      txid = await broadcastEvmTx(swapRpcUrl, serializedHex, fromAddress)
      swapLog(`${TAG} Broadcast via direct RPC: ${txid}`)
    } catch (directErr: any) {
      // A signer-verification failure is a local safety decision, not an RPC
      // availability problem. Never route the rejected bytes around the guard
      // through Pioneer.
      if (directErr instanceof EvmSignerVerificationError) throw directErr

      // The pre-sign balance check in buildRelaySwapTx already verified
      // value + gas <= native balance against this same RPC URL. So a node
      // "insufficient funds" here is NOT a real gas shortage — it's a stale
      // view from the load-balanced endpoint (the balance read and the
      // broadcast can hit different backends) or an in-flight pending tx.
      // Do NOT relabel it as "add ETH for gas" (that misleads the user) and
      // do NOT swallow the original message — log it and fall through to
      // Pioneer, which may reach a better-synced node.
      console.warn(`${TAG} Direct RPC broadcast failed (${directErr.message}), falling back to Pioneer...`)
      try {
        const result = await txb.broadcastTx(pioneer, fromChain, signedTx)
        txid = result.txid
      } catch (pioneerErr: any) {
        console.error(`${TAG} BROADCAST FAILED (both direct RPC and Pioneer):`)
        console.error(`${TAG}   Direct: ${directErr.message}`)
        console.error(`${TAG}   Pioneer: ${pioneerErr.message}`)
        throw pioneerErr
      }
    }
  } else {
    try {
      const result = await txb.broadcastTx(pioneer, fromChain, signedTx)
      txid = result.txid
    } catch (e: any) {
      console.error(`${TAG} BROADCAST FAILED: ${e.message}`)
      console.error(`${TAG}   signedTx keys: ${signedTx ? Object.keys(signedTx).join(', ') : 'null'}`)
      throw e
    }
  }

  swapLog(`${TAG} Broadcast success: ${txid}`)

  return {
    txid,
    fromCaip: params.fromCaip,
    toCaip: params.toCaip,
    fromAmount: params.amount,
    expectedOutput: params.expectedOutput,
    ...(approvalTxid ? { approvalTxid } : {}),
    ...(fromAmountBaseUnits ? { fromAmountBaseUnits } : {}),
  }
}

// ── Relay swap tx building (pre-built calldata from bridge protocol) ──

/** Build the unsigned swap tx(s) without signing or broadcasting. Used by
 *  the UI to surface the exact hdwallet payload on the Confirm Quote screen
 *  so the user can audit before clicking Confirm. For ERC-20 sources that
 *  need approval, returns BOTH the approve tx and the projected deposit tx
 *  (with nonce assumed to advance after approval). */
export async function previewSwapBuild(
  params: ExecuteSwapParams,
  ctx: SwapContext,
): Promise<{ approveTx?: any; unsignedTx: any; allowance?: { current: string; required: string; sufficient: boolean; spender: string; tokenContract: string }; balance?: { current: string; required: string; sufficient: boolean; tokenContract?: string } }> {
  const { wallet, getAllChains, getRpcUrl, getBtcXpub, getAllBtcXpubs } = ctx

  const allChains = getAllChains()
  const fromChain = allChains.find(c => c.id === params.fromChainId)
  if (!fromChain) throw new Error(`Unknown source chain: ${params.fromChainId}`)
  const toChain = allChains.find(c => c.id === params.toChainId)
  if (!toChain) throw new Error(`Unknown destination chain: ${params.toChainId}`)

  const isErc20Source = isTokenCaip(params.fromCaip) && fromChain.chainFamily === 'evm'

  let fromAddress = params.fromAddressOverride
  if (!fromAddress) {
    const fromPath = fromChain.chainFamily === 'evm' && params.fromEvmAddressIndex != null
      ? evmAddressPath(params.fromEvmAddressIndex)
      : fromChain.defaultPath
    const addrParams: any = {
      addressNList: fromPath,
      showDisplay: false,
      coin: fromChain.chainFamily === 'evm' ? 'Ethereum' : fromChain.coin,
    }
    if (fromChain.scriptType) addrParams.scriptType = fromChain.scriptType
    const addrMethod = fromChain.id === 'ripple' ? 'rippleGetAddress' : fromChain.rpcMethod
    const addrResult = await wallet[addrMethod](addrParams)
    fromAddress = typeof addrResult === 'string' ? addrResult : addrResult?.address
  }
  if (!fromAddress) throw new Error('Could not derive sender address')

  const hasPrebuiltTx = !!params.relayTx
  const isNativeDeposit = isNativeDepositCaip(params.fromCaip)
  const fromIsUtxoPreview = params.fromCaip.startsWith('bip122:')
  const fromIsSolanaPreview = params.fromCaip.startsWith('solana:')
  const isMemolessTransfer = (fromIsUtxoPreview || fromIsSolanaPreview) && !!params.inboundAddress && !params.memo
  if (!params.inboundAddress && !isNativeDeposit && !hasPrebuiltTx) throw new Error('Missing inbound vault address from quote')
  if (!params.memo && !hasPrebuiltTx && !isMemolessTransfer) throw new Error('Missing swap memo from quote')
  assertSwapMemoFitsSource(params.memo, params.fromCaip)

  const pioneer = await getPioneer()

  if (hasPrebuiltTx) {
    if (fromChain.chainFamily === 'solana' && params.relayTx?.serializedTx) {
      return { unsignedTx: { addressNList: fromChain.defaultPath, rawTx: params.relayTx.serializedTx } }
    }
    if (fromChain.chainFamily === 'tron') {
      // Tron has no nonces — buildRelaySwapTx is EVM-only. Route through TronGrid txbuilder.
      const knownAssets = await getSwapAssets()
      const fromAssetMeta = knownAssets.find(a => a.caip === params.fromCaip)
      const buildResult = await txb.buildTx(pioneer, fromChain, {
        chainId: fromChain.id,
        to: params.relayTx!.to || params.inboundAddress,
        amount: params.amount, memo: params.memo || '', feeLevel: params.feeLevel, isMax: params.isMax,
        isSwapDeposit: true, fromAddress,
        caip: fromAssetMeta?.caip ?? params.fromCaip, tokenDecimals: fromAssetMeta?.decimals ?? params.tokenDecimals,
      })
      return { unsignedTx: buildResult.unsignedTx }
    }
    const result = await buildRelaySwapTx(params, fromChain, fromAddress, getRpcUrl, isErc20Source, /* previewMode */ true)
    return { unsignedTx: result.unsignedTx, approveTx: result.approveTx, allowance: result.allowance, balance: result.balance }
  }
  if (fromChain.chainFamily === 'evm') {
    const result = await buildEvmSwapTx(params, fromChain, fromAddress, pioneer, getRpcUrl, isErc20Source, wallet, /* previewMode */ true)
    return { unsignedTx: result.unsignedTx, approveTx: result.approveTx, allowance: result.allowance, balance: result.balance }
  }
  if (fromChain.chainFamily === 'utxo') {
    let xpub: string | undefined
    let scriptTypeOverride: string | undefined
    let accountPath: number[] | undefined
    let allXpubs: Array<{ xpub: string; scriptType: string; accountPath: number[] }> | undefined
    if (isBitcoin(fromChain)) {
      try {
        allXpubs = getAllBtcXpubs()
        if (allXpubs.length > 0) {
          const btcInfo = getBtcXpub()
          xpub = btcInfo?.xpub || allXpubs[0].xpub
          scriptTypeOverride = btcInfo?.scriptType || allXpubs[0].scriptType
          accountPath = btcInfo?.accountPath || allXpubs[0].accountPath
        }
      } catch { /* BTC account manager not ready */ }
      // The cached btc-account-manager fallback ONLY applies to BTC. Without
      // this gate the preview path picked up the user's BTC zpub
      // (m/84'/0'/0', p2wpkh) and queried Pioneer for ZEC unspents under the
      // Bitcoin native-segwit account — Pioneer naturally returned 0 UTXOs.
      // Symptom: "Build preview failed: No UTXOs found for Zcash" while
      // standalone ZEC sends worked because they take a different code path.
      if (!xpub) {
        const btcInfo = (() => { try { return getBtcXpub() } catch { return undefined } })()
        if (btcInfo) { xpub = btcInfo.xpub; scriptTypeOverride = btcInfo.scriptType; accountPath = btcInfo.accountPath }
      }
    }
    if (!xpub && isBitcoin(fromChain)) {
      // Lazy-init: same as executeSwap — derive all supported BTC scriptTypes when
      // btcAccountManager is empty. See executeSwap path for rationale.
      const btcScriptTypes = await supportedBtcScriptTypes(wallet)
      const paths = btcScriptTypes.map(st => ({
        addressNList: btcAccountPath(st.purpose, 0),
        coin: 'Bitcoin',
        scriptType: st.scriptType,
        curve: 'secp256k1',
      }))
      const results = await wallet.getPublicKeys(paths)
      const derived: Array<{ xpub: string; scriptType: string; accountPath: number[] }> = []
      for (let i = 0; i < btcScriptTypes.length; i++) {
        const xp = results?.[i]?.xpub
        if (xp) derived.push({ xpub: xp, scriptType: btcScriptTypes[i].scriptType, accountPath: paths[i].addressNList })
      }
      if (derived.length > 0) {
        const native = derived.find(d => d.scriptType === 'p2wpkh') || derived[0]
        xpub = native.xpub
        scriptTypeOverride = native.scriptType
        accountPath = native.accountPath
        allXpubs = derived
      }
    }
    if (!xpub) {
      const result = await wallet.getPublicKeys([{
        addressNList: fromChain.defaultPath.slice(0, 3),
        coin: fromChain.coin,
        scriptType: fromChain.scriptType,
        curve: 'secp256k1',
      }])
      xpub = result?.[0]?.xpub
    }
    const buildResult = await txb.buildTx(pioneer, fromChain, {
      chainId: fromChain.id, to: params.inboundAddress, amount: params.amount, memo: params.memo,
      feeLevel: params.feeLevel, isMax: params.isMax, fromAddress, xpub, allXpubs, scriptTypeOverride, accountPath,
    })
    return { unsignedTx: buildResult.unsignedTx }
  }
  // cosmos / xrp / solana / tron / ton
  const knownAssets = await getSwapAssets()
  const fromAssetMeta = knownAssets.find(a => a.caip === params.fromCaip)
  const buildResult = await txb.buildTx(pioneer, fromChain, {
    chainId: fromChain.id,
    to: params.inboundAddress || fromAddress,
    amount: params.amount, memo: params.memo, feeLevel: params.feeLevel, isMax: params.isMax,
    isSwapDeposit: true, fromAddress,
    // Prefer Pioneer's canonical CAIP (correct case for TRON tokens) but fall
    // back to the picker-supplied CAIP for synthesized selections. Same for
    // decimals: synthesized token sources (e.g. SPL USDT, absent from
    // Pioneer's available-assets) carry them in params.tokenDecimals.
    caip: fromAssetMeta?.caip ?? params.fromCaip, tokenDecimals: fromAssetMeta?.decimals ?? params.tokenDecimals,
    // Match the execute path: THOR.TCY/THOR.RUJI deposit asset, not the
    // hardcoded THOR.RUNE default, so the preview shows the right coin.
    depositAsset: fromAssetMeta?.asset,
  })
  return { unsignedTx: buildResult.unsignedTx }
}

async function buildRelaySwapTx(
  params: ExecuteSwapParams,
  fromChain: ChainDef,
  fromAddress: string,
  getRpcUrl: (chain: ChainDef) => string | undefined,
  isErc20Source = false,
  _previewMode = false,  // reserved — caller (executeSwap vs previewSwapBuild) handles signing/broadcasting
): Promise<{ unsignedTx: any; approveTx?: any; fromAmountBaseUnits?: string; allowance?: { current: string; required: string; sufficient: boolean; spender: string; tokenContract: string }; balance?: { current: string; required: string; sufficient: boolean; tokenContract?: string } }> {
  const relay = params.relayTx!
  const evmSigningPath = params.fromEvmAddressIndex != null
    ? evmAddressPath(params.fromEvmAddressIndex)
    : fromChain.defaultPath
  console.log(`${TAG} buildRelaySwapTx: relay.value=${relay.value} relay.gasLimit=${relay.gasLimit} relay.maxFeePerGas=${relay.maxFeePerGas} relay.maxPriorityFeePerGas=${relay.maxPriorityFeePerGas}`)

  // Guard: when the quote ships a chainId, it MUST match the locally-resolved
  // source chain to prevent signing a tx for chain A with a nonce from chain
  // B (real risk for cross-chain bridges like Relay). Single-chain
  // aggregators (e.g. shapeshiftSwap on ETH → ETH) omit chainId because
  // it's implicit; in that case we trust the source chain.
  const expectedChainId = parseInt(fromChain.chainId || '0', 10)
  if (relay.chainId != null && relay.chainId !== expectedChainId) {
    throw new Error(
      `Quote chainId mismatch: quote says ${relay.chainId} but source chain ${fromChain.id} is ${expectedChainId}. ` +
      `Aborting — stale or mismatched quote.`
    )
  }

  const chainId = expectedChainId
  const rpcUrl = getRpcUrl(fromChain)

  // Fetch nonce (relay tx doesn't include it)
  let nonce: number | undefined
  if (rpcUrl) {
    try { nonce = await getEvmNonce(rpcUrl, fromAddress) } catch (e: any) {
      console.warn(`${TAG} Failed to fetch nonce via RPC for relay tx: ${e.message}`)
    }
  }
  if (nonce === undefined) {
    const pioneer = await getPioneer()
    try {
      const nd = await pioneer.GetNonceByNetwork({ networkId: fromChain.networkId, address: fromAddress })
      nonce = nd?.data?.nonce
    } catch (e: any) {
      console.warn(`${TAG} Failed to fetch nonce via Pioneer for relay tx: ${e.message}`)
    }
  }
  if (nonce === undefined || nonce === null) {
    throw new Error(`Failed to fetch nonce for ${fromAddress} on ${fromChain.id} — cannot build relay tx`)
  }

  // Use gas params from relay quote, with sane fallbacks.
  // Mirror the normal EVM path: try quote fields → RPC → Pioneer → chain-specific floor.
  //
  // Relay gas limit: use quote-provided value, then chain-specific fallback.
  // 300000 is correct only for Arbitrum (different gas accounting). L2s like
  // Base/Optimism use mainnet-equivalent gas units; 300000 overestimates by 3-6x
  // and causes the pre-sign balance check to fail on tight balances.
  const RELAY_GAS_LIMIT_FALLBACK: Record<string, string> = {
    arbitrum: '300000',
    base: '100000',
    optimism: '100000',
    polygon: '150000',
    avalanche: '150000',
    bsc: '150000',
    ethereum: '150000',
  }
  const gasLimit = relay.gasLimit || RELAY_GAS_LIMIT_FALLBACK[fromChain.id] || '150000'
  console.log(`${TAG} relay gasLimit: provided=${relay.gasLimit} resolved=${gasLimit} chain=${fromChain.id}`)
  const fallbackGwei = MIN_GAS_GWEI[fromChain.id] ?? 10
  const fallbackGasPrice = BigInt(Math.round(fallbackGwei * 1e9))
  // Firmware EIP-1559 signing is broken for chainId >= 256: the firmware hashes
  // only the LSB of chainId instead of the full big-endian RLP encoding, so the
  // signature recovers to a wrong address on Base (8453), Arbitrum (42161), and
  // Avalanche (43114). Chains with chainId <= 255 (ETH=1, OP=10, BSC=56, Polygon=137)
  // happen to be correct. Force legacy gasPrice for affected chains until the
  // firmware bug is fixed in ethereum.c (hash_rlp_number vs hash_rlp_field).
  const eip1559Ok = chainId < 256

  let gasPrice: string | undefined
  let maxFeePerGas: string | undefined
  let maxPriorityFeePerGas: string | undefined

  if (relay.maxFeePerGas && eip1559Ok) {
    // EIP-1559 tx — start from Relay's quote, but cross-check against our own
    // locally-computed buffer (nextBaseFee * 3 + 1.5 gwei priority floor). Relay
    // can ship a maxFeePerGas that was current at quote time but stale by
    // broadcast; if local says higher, we use local so the tx isn't stranded
    // when base fee spikes between quote and signing.
    const relayMaxFee = BigInt(relay.maxFeePerGas)
    const relayPrio = relay.maxPriorityFeePerGas
      ? BigInt(relay.maxPriorityFeePerGas)
      : BigInt(1_500_000_000) // 1.5 gwei — typical ETH-mainnet inclusion tip
    let chosenMaxFee = relayMaxFee
    let chosenPrio = relayPrio
    if (rpcUrl) {
      const liveFee = await getEvmFeeData(rpcUrl).catch(() => null)
      if (liveFee) {
        if (liveFee.maxFeePerGas > chosenMaxFee) {
          swapLog(`${TAG} Relay tx: bumping maxFeePerGas ${chosenMaxFee} → ${liveFee.maxFeePerGas} (local 3x buffer beats Relay quote)`)
          chosenMaxFee = liveFee.maxFeePerGas
        }
        if (liveFee.maxPriorityFeePerGas > chosenPrio) chosenPrio = liveFee.maxPriorityFeePerGas
      }
    }
    if (chosenPrio > chosenMaxFee) {
      swapLog(`${TAG} Relay tx: bumping maxFeePerGas ${chosenMaxFee} → ${chosenPrio} to cover maxPriorityFeePerGas`)
      chosenMaxFee = chosenPrio
    }
    maxFeePerGas = toHex(chosenMaxFee)
    maxPriorityFeePerGas = toHex(chosenPrio)
  } else if (rpcUrl) {
    // Quote shipped only legacy gasPrice (or nothing) — prefer EIP-1559 from RPC
    // since legacy gasPrice on EIP-1559 chains often comes back below base fee.
    // Skip EIP-1559 for chainId >= 256 (firmware signing bug, see eip1559Ok above).
    const feeData = eip1559Ok ? await getEvmFeeData(rpcUrl) : null
    if (feeData) {
      // Floor maxFeePerGas at 2x chain min (so we still beat base on quiet chains)
      const floor1559 = fallbackGasPrice * 2n
      maxFeePerGas = toHex(feeData.maxFeePerGas > floor1559 ? feeData.maxFeePerGas : floor1559)
      maxPriorityFeePerGas = toHex(feeData.maxPriorityFeePerGas)
      swapLog(`${TAG} Relay tx: using EIP-1559 from RPC (maxFee=${feeData.maxFeePerGas}, prio=${feeData.maxPriorityFeePerGas})`)
    } else {
      // Chain doesn't support eth_feeHistory — fall back to legacy gasPrice with floor
      try {
        const gp = await getEvmGasPrice(rpcUrl)
        gasPrice = toHex(gp < fallbackGasPrice ? fallbackGasPrice : gp)
      } catch {
        gasPrice = toHex(fallbackGasPrice)
      }
    }
  }
  if (!maxFeePerGas && !gasPrice) {
    // No RPC available — last-resort Pioneer + floor
    try {
      const pioneer = await getPioneer()
      const gp = await pioneer.GetGasPriceByNetwork({ networkId: fromChain.networkId })
      const gpData = gp?.data
      const gpGwei = typeof gpData === 'object'
        ? parseFloat(gpData.average || gpData.fast || String(fallbackGwei))
        : parseFloat(gpData || String(fallbackGwei))
      const gpWei = BigInt(Math.round((isNaN(gpGwei) ? fallbackGwei : gpGwei) * 1e9))
      gasPrice = toHex(gpWei < fallbackGasPrice ? fallbackGasPrice : gpWei)
    } catch (e: any) {
      console.warn(`${TAG} Pioneer gas price failed for relay tx, using ${fallbackGwei} gwei floor: ${e.message}`)
      gasPrice = toHex(fallbackGasPrice)
    }
  }

  const relayValue = BigInt(relay.value)
  const relayGasLimit = BigInt(gasLimit)
  const relayFeePerGas = maxFeePerGas || gasPrice
  if (!relayFeePerGas) {
    throw new Error(`Unable to determine gas fee for Relay transaction on ${fromChain.id} — refusing to sign. Try refreshing the quote.`)
  }
  // EIP-1559 nodes require the sender to cover gasLimit * maxFeePerGas + value before
  // broadcasting. The balance check and the fee cap placed in the signed tx MUST agree,
  // otherwise a tight balance passes the check but the broadcast rejects.
  //
  // Strategy: take the relay's own quoted maxFeePerGas as the signed cap. The live bump
  // computed above is discarded — the relay quote already reflects current network conditions
  // at quote time, and on L2s (Base, Optimism) the 3× live-buffer produces wildly over-
  // estimated caps that block valid swaps on tight balances. If the relay's cap proves
  // insufficient for inclusion, the tx will be mined anyway at priority-fee level once
  // the base fee drops — or the user can refresh the quote to get a fresh cap.
  const signedFeePerGas: bigint = (relay.maxFeePerGas && eip1559Ok)
    ? BigInt(relay.maxFeePerGas)
    : BigInt(relayFeePerGas)  // no quoted fee → fall back to live (gasPrice path)
  const signedPrioFeePerGas: bigint = relay.maxPriorityFeePerGas
    ? BigInt(relay.maxPriorityFeePerGas)
    : signedFeePerGas  // no quoted prio → cap at max
  const relayGasReserve = relayGasLimit * signedFeePerGas
  // ERC-20 relay swaps run an approve tx before the swap. Reserve gas for both.
  const approveGasReserve = isErc20Source ? 80000n * signedFeePerGas : 0n
  const relayNativeRequired = relayValue + relayGasReserve + approveGasReserve
  console.log(`${TAG} relay fee: quoted=${relay.maxFeePerGas} liveBumped=${relayFeePerGas} signedCap=${signedFeePerGas}`)
  let nativeBalance: bigint | undefined
  if (rpcUrl) {
    try {
      nativeBalance = await getEvmBalance(rpcUrl, fromAddress)
    } catch (e: any) {
      console.warn(`${TAG} Failed to fetch native balance via RPC for relay tx: ${e.message}`)
    }
  }
  if (nativeBalance === undefined) {
    try {
      const pioneer = await getPioneer()
      const bd = await pioneer.GetBalanceAddressByNetwork({ networkId: fromChain.networkId, address: fromAddress })
      const balStr = String(bd?.data?.nativeBalance || bd?.data?.balance || '0')
      nativeBalance = parseUnits(balStr, fromChain.decimals)
    } catch (e: any) {
      console.warn(`${TAG} Failed to fetch native balance via Pioneer for relay tx: ${e.message}`)
    }
  }
  if (nativeBalance === undefined) {
    throw new Error(`Unable to verify ${fromChain.symbol} balance for Relay transaction — refusing to sign. Try refreshing the quote.`)
  }
  // sendMax trim for deposit-channel swaps (Chainflip / NEAR Intents):
  // For these the deposited value is fully under our control. Trim to fit when:
  //   (a) isMax=true — frontend sent full balance, no gas reserve subtracted yet
  //   (b) isMax=false + wouldExceed — balance changed since the quote was fetched
  // Calldata relay txs (standard Relay routes) are NOT trimmed here — the relay.data
  // encodes the route and the value must match what was quoted. A large mismatch means
  // the quote was fetched from a different address; fail loudly so the user re-quotes.
  let effectiveRelayValue = relayValue
  if (relay.isDepositChannel && !isErc20Source && nativeBalance > relayGasReserve) {
    const wouldExceed = relayValue + relayGasReserve > nativeBalance
    if (params.isMax || wouldExceed) {
      effectiveRelayValue = nativeBalance - relayGasReserve
      console.log(`${TAG} deposit channel value trim (isMax=${params.isMax}, stale=${wouldExceed && !params.isMax}): ${formatWei(relayValue, fromChain.decimals)} → ${formatWei(effectiveRelayValue, fromChain.decimals)} ${fromChain.symbol} (live bal: ${formatWei(nativeBalance, fromChain.decimals)}, gas: ${formatWei(relayGasReserve, fromChain.decimals)})`)
    }
  }
  const effectiveRelayRequired = effectiveRelayValue + relayGasReserve + approveGasReserve
  console.log(`${TAG} relay gas check: value=${formatWei(effectiveRelayValue, fromChain.decimals)} gasReserve=${formatWei(relayGasReserve, fromChain.decimals)} required=${formatWei(effectiveRelayRequired, fromChain.decimals)} balance=${formatWei(nativeBalance, fromChain.decimals)} ${fromChain.symbol}`)
  if (nativeBalance < effectiveRelayRequired) {
    const haveStr = formatWei(nativeBalance, fromChain.decimals)
    const needStr = formatWei(effectiveRelayRequired, fromChain.decimals)
    const valStr = formatWei(effectiveRelayValue, fromChain.decimals)
    const gasStr = formatWei(relayGasReserve, fromChain.decimals)
    // Large mismatch (value > 2× balance) almost always means a stale quote from
    // a different address — tell the user explicitly rather than suggesting MAX.
    if (!relay.isDepositChannel && relayValue > nativeBalance * 2n) {
      throw new Error(
        `Quote was built for a different address (quoted ${formatWei(relayValue, fromChain.decimals)} ${fromChain.symbol} but signing address only has ${haveStr}). ` +
        `Select the correct address in the "From address" selector and re-quote.`
      )
    }
    if (params.isMax && !isErc20Source) {
      throw new Error(
        `Relay quote is stale: updated gas fees require ${needStr} ${fromChain.symbol} ` +
        `but the wallet has ${haveStr}. Refresh the quote so the max send amount can reserve gas before signing.`
      )
    }
    throw new Error(
      `Insufficient ${fromChain.symbol} for Relay transaction: need ${needStr} ` +
      `(${valStr} value + ${gasStr} gas), have ${haveStr}. ` +
      `If you used MAX, your balance may have changed — go back and re-enter MAX with your current balance.`
    )
  }

  // ── ERC-20 allowance check & approve generation ────────────────────
  // Relay-aggregator txs (e.g. shapeshiftSwap calling THORChain Router) pull
  // ERC-20 tokens via transferFrom — the user MUST have approved relay.to as
  // the spender. Without this check the swap silently reverts on-chain.
  let pendingApproveTx: any | undefined
  let allowanceInfo: { current: string; required: string; sufficient: boolean; spender: string; tokenContract: string } | undefined
  let balanceInfo: { current: string; required: string; sufficient: boolean; tokenContract?: string } | undefined

  if (isErc20Source && rpcUrl) {
    const tokenContract = (extractContractFromCaip(params.fromCaip) || '').toLowerCase()
    // NEAR Intents ERC-20: relay.to IS the token contract (direct transfer to solver).
    // No approval needed, but balance must still be checked.
    const isDirectTransfer = relay.to.toLowerCase() === tokenContract
    if (tokenContract && tokenContract.startsWith('0x')) {
      try {
        const tokenDecimals = await getErc20Decimals(rpcUrl, tokenContract).catch(() => undefined)
        if (tokenDecimals !== undefined) {
          const amountBaseUnits = parseUnits(params.amount, tokenDecimals)

          // Always check balance — direct transfers revert on-chain if insufficient.
          const currentBalance = await getErc20Balance(rpcUrl, tokenContract, fromAddress).catch(() => null)
          if (currentBalance !== null) {
            const balSufficient = currentBalance >= amountBaseUnits
            balanceInfo = {
              current: currentBalance.toString(),
              required: amountBaseUnits.toString(),
              sufficient: balSufficient,
              tokenContract,
            }
            swapLog(`${TAG} Relay tx balance check: current=${currentBalance}, required=${amountBaseUnits}, sufficient=${balSufficient}`)
            if (!balSufficient && !_previewMode) {
              throw new Error(`Insufficient ${tokenContract} balance: have ${currentBalance.toString()} units, need ${amountBaseUnits.toString()} units. The swap would revert on-chain — refusing to sign.`)
            }
          }

          // Approval only needed when routing through a spender contract.
          if (!isDirectTransfer) {
            const currentAllowance = await getErc20Allowance(rpcUrl, tokenContract, fromAddress, relay.to).catch(() => 0n)
            const sufficient = currentAllowance >= amountBaseUnits
            allowanceInfo = {
              current: currentAllowance.toString(),
              required: amountBaseUnits.toString(),
              sufficient,
              spender: relay.to,
              tokenContract,
            }
            swapLog(`${TAG} Relay tx allowance check: current=${currentAllowance}, required=${amountBaseUnits}, sufficient=${sufficient}`)
            if (!sufficient) {
              const approveData = encodeApprove(relay.to, amountBaseUnits)
              const approveGasLimit = 80000n
              const approveTx: any = {
                chainId,
                addressNList: evmSigningPath,
                nonce: toHex(BigInt(nonce)),
                gasLimit: toHex(approveGasLimit),
                to: tokenContract,
                value: '0x0',
                data: approveData,
              }
              if (maxFeePerGas) {
                approveTx.maxFeePerGas = toHex(signedFeePerGas)
                approveTx.maxPriorityFeePerGas = toHex(signedPrioFeePerGas)
              } else if (gasPrice) {
                approveTx.gasPrice = gasPrice
              }
              pendingApproveTx = approveTx
              nonce += 1
            }
          }
        }
      } catch (e: any) {
        console.warn(`${TAG} Relay ERC-20 check failed (non-fatal): ${e?.message}`)
      }
    }
  }

  // Build ethSignTx params for hdwallet
  const unsignedTx: any = {
    addressNList: evmSigningPath,
    chainId,
    nonce: toHex(BigInt(nonce)),
    gasLimit: toHex(BigInt(gasLimit)),
    to: relay.to,
    value: toHex(effectiveRelayValue),
    data: relay.data,
  }

  // Attach a signed v2 clear-sign schema when one covers this exact
  // (chain, contract, selector). The schema names the method and its args but
  // no amounts and no tx hash, so the device decodes the values from the
  // calldata it is about to sign — turning a blind-sign prompt into a labelled
  // review. Absent or mismatched: nothing is attached and behaviour is
  // unchanged, so this can never block a swap.
  const evmSchema = findEvmSchema(chainId, relay.to, relay.data)
  if (evmSchema) {
    unsignedTx.txMetadata = { signedPayload: evmSchema.signedPayload, keyId: evmSchema.keyId }
    swapLog(`${TAG} clear-sign schema attached: ${evmSchema.method} (keyId=${evmSchema.keyId})`)
  }

  // EIP-1559 fields — use signedFeePerGas (relay's quoted cap) so the signed tx
  // matches the balance check above. Using the live-bumped cap here while checking
  // against the quoted cap would allow a tx that the account cannot cover.
  // Skip EIP-1559 for chainId >= 256 (firmware signing bug, see eip1559Ok above).
  if (relay.maxFeePerGas && eip1559Ok) {
    unsignedTx.maxFeePerGas = toHex(signedFeePerGas)
    unsignedTx.maxPriorityFeePerGas = toHex(signedPrioFeePerGas)
  } else if (gasPrice) {
    unsignedTx.gasPrice = gasPrice
  } else if (maxFeePerGas) {
    // No relay-quoted fee — fall back to live-bumped (consistent with signedFeePerGas fallback above)
    unsignedTx.maxFeePerGas = maxFeePerGas
    unsignedTx.maxPriorityFeePerGas = maxPriorityFeePerGas || toHex(1_000_000n)
  }

  // Sanity guard — ERC-20 sources ALWAYS need calldata (transferFrom or
  // approveAndDeposit). An empty data field on an ERC-20 relay tx means we'd
  // broadcast a plain 0-value transfer with no swap instruction.
  //
  // Historical incidents:
  //   - USDT→BTC (Maya, txid 0x8426ca…) — ERC-20 source, dust transfer to non-vault EOA
  //
  // Cross-chain native-asset swaps via deposit-channel protocols
  // (Chainflip) legitimately use `data = '0x'` — the swap
  // destination was registered off-chain when the quote/channel was created.
  // These are flagged `relay.isDepositChannel = true` by parseQuoteResponse
  // so we can distinguish them from truly malformed quotes.
  const dataIsEmpty = !relay.data || relay.data === '0x' || relay.data === '0x0' || relay.data.length < 10
  if (dataIsEmpty && isErc20Source) {
    throw new Error(
      `Refusing to sign: source is ERC-20 but relayTx has empty calldata. ` +
      `Broadcasting would send a plain transfer to ${relay.to} — no token transfer encoded. ` +
      `Pioneer returned a malformed quote — try a different route or pair.`
    )
  }
  if (dataIsEmpty && !relay.isDepositChannel) {
    const isCrossChain = params.fromChainId !== params.toChainId
    if (isCrossChain) {
      throw new Error(
        `Refusing to sign: cross-chain swap (${params.fromChainId} → ${params.toChainId}) ` +
        `but relayTx has empty calldata and is not a recognized deposit-channel protocol. ` +
        `Broadcasting would send a plain transfer to ${relay.to} with value=${relay.value} ` +
        `instead of executing the swap. Pioneer returned a malformed quote — try a different route or pair.`
      )
    }
  }

  swapLog(`${TAG} Relay tx built: nonce=${nonce}, gasLimit=${gasLimit}, chainId=${chainId}, to=${relay.to}, value=${relay.value}`)

  // Compute base units for the sell amount — needed by the swap tracker so
  // registerWithPioneer can send an integer amountBaseUnits to Pioneer's API.
  // Non-direct path: balanceInfo.required already has it (set above).
  // Direct transfer (NEAR Intents ERC-20): decode transfer(address,uint256) calldata.
  let fromAmountBaseUnits: string | undefined = balanceInfo?.required
  if (!fromAmountBaseUnits && isErc20Source) {
    const data = relay.data || ''
    // transfer(address,uint256): 0xa9059cbb + 32-byte addr + 32-byte amount = 138 hex chars
    if (data.length === 138 && data.toLowerCase().startsWith('0xa9059cbb')) {
      try { fromAmountBaseUnits = BigInt('0x' + data.slice(74)).toString() } catch {}
    }
  }

  return { unsignedTx, approveTx: pendingApproveTx, allowance: allowanceInfo, balance: balanceInfo, fromAmountBaseUnits }
}

// ── EVM swap tx building (extracted for readability) ────────────────

async function buildEvmSwapTx(
  params: ExecuteSwapParams,
  fromChain: ChainDef,
  fromAddress: string,
  pioneer: any,
  getRpcUrl: (chain: ChainDef) => string | undefined,
  isErc20Source: boolean,
  wallet: any,
  previewMode = false,
  stage: (s: SwapSubStage) => void = () => {},
): Promise<{ unsignedTx: any; approvalTxid?: string; approveTx?: any; allowance?: { current: string; required: string; sufficient: boolean; spender: string; tokenContract: string }; balance?: { current: string; required: string; sufficient: boolean; tokenContract?: string } }> {
  // Some protocols (e.g. Mayachain) only return `inboundAddress` and use it as the
  // router for EVM deposits. Accept either; throw only if both are missing.
  const routerAddress = params.router || params.inboundAddress
  if (!routerAddress) throw new Error('EVM swaps require a router/inboundAddress from the quote')

  const evmSigningPath = params.fromEvmAddressIndex != null
    ? evmAddressPath(params.fromEvmAddressIndex)
    : fromChain.defaultPath

  // Use expiry from quote if available, otherwise 1 hour from now
  const expiry = params.expiry && params.expiry > Math.floor(Date.now() / 1000)
    ? params.expiry
    : Math.floor(Date.now() / 1000) + 3600
  const chainId = parseInt(fromChain.chainId || '1', 10)
  const rpcUrl = getRpcUrl(fromChain)

  // Fetch gas price (preferring EIP-1559), nonce, native balance.
  // EIP-1559 path: maxFeePerGas + maxPriorityFeePerGas, used on chains that support eth_feeHistory.
  // Legacy path: gasPrice, used as fallback. Both paths enforce a chain-specific floor.
  //
  // Firmware EIP-1559 signing bug: chainId >= 256 hashes only the LSB of chainId.
  // Force legacy gasPrice for Base (8453), Arbitrum (42161), Avalanche (43114), etc.
  // See buildRelaySwapTx comment and ethereum.c for details.
  const eip1559Ok = chainId < 256

  const fallbackGwei = MIN_GAS_GWEI[fromChain.id] ?? 10
  const fallbackGasPrice = BigInt(Math.round(fallbackGwei * 1e9))
  let gasPrice: bigint = fallbackGasPrice
  let maxFeePerGas: bigint | undefined
  let maxPriorityFeePerGas: bigint | undefined

  if (rpcUrl) {
    const feeData = eip1559Ok ? await getEvmFeeData(rpcUrl) : null
    if (feeData) {
      const floor1559 = fallbackGasPrice * 2n
      maxFeePerGas = feeData.maxFeePerGas > floor1559 ? feeData.maxFeePerGas : floor1559
      maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
      swapLog(`${TAG} Using EIP-1559 (maxFee=${maxFeePerGas}, prio=${maxPriorityFeePerGas}) for ${fromChain.id}`)
    } else {
      try { gasPrice = await getEvmGasPrice(rpcUrl) } catch (e: any) {
        console.warn(`${TAG} Failed to fetch gas price via RPC, using ${fallbackGwei} gwei fallback for ${fromChain.id}: ${e.message}`)
      }
    }
  } else {
    try {
      const gp = await pioneer.GetGasPriceByNetwork({ networkId: fromChain.networkId })
      const gpData = gp?.data
      const gpGwei = typeof gpData === 'object' ? parseFloat(gpData.average || gpData.fast || String(fallbackGwei)) : parseFloat(gpData || String(fallbackGwei))
      gasPrice = BigInt(Math.round((isNaN(gpGwei) ? fallbackGwei : gpGwei) * 1e9))
    } catch (e: any) {
      console.warn(`${TAG} Failed to fetch gas price via Pioneer, using ${fallbackGwei} gwei fallback for ${fromChain.id}: ${e.message}`)
    }
  }

  // Enforce minimum floor on legacy path
  if (!maxFeePerGas && gasPrice < fallbackGasPrice) {
    swapLog(`${TAG} Gas price ${gasPrice} below floor ${fallbackGasPrice} (${fallbackGwei} gwei) — using floor`)
    gasPrice = fallbackGasPrice
  }

  // Apply user fee level (1-9: 1-2 = slow, 8-9 = fast). Scales whichever fee field is in use.
  const feeLevelMul = (n: bigint): bigint => {
    if (params.feeLevel != null && params.feeLevel <= 2) return n * 80n / 100n
    if (params.feeLevel != null && params.feeLevel >= 8) return n * 150n / 100n
    return n
  }
  if (maxFeePerGas) {
    maxFeePerGas = feeLevelMul(maxFeePerGas)
    maxPriorityFeePerGas = feeLevelMul(maxPriorityFeePerGas!)
  } else {
    gasPrice = feeLevelMul(gasPrice)
  }

  let nonce: number | undefined
  if (rpcUrl) {
    try { nonce = await getEvmNonce(rpcUrl, fromAddress) } catch (e: any) {
      console.warn(`${TAG} Failed to fetch nonce via RPC: ${e.message}`)
    }
  }
  if (nonce === undefined) {
    try {
      const nd = await pioneer.GetNonceByNetwork({ networkId: fromChain.networkId, address: fromAddress })
      nonce = nd?.data?.nonce
    } catch (e: any) {
      console.warn(`${TAG} Failed to fetch nonce via Pioneer: ${e.message}`)
    }
  }
  if (nonce === undefined || nonce === null) {
    throw new Error(`Failed to fetch nonce for ${fromAddress} on ${fromChain.id} — cannot safely build swap transaction`)
  }

  // A failed balance fetch is NOT a zero balance. Try RPC, then Pioneer, then
  // give up loudly — defaulting to 0n produced "Insufficient ETH: need 1.65,
  // have 0" on funded accounts whenever the public RPC hiccuped. Same posture
  // as buildRelaySwapTx.
  let nativeBalance: bigint | undefined
  if (rpcUrl) {
    try { nativeBalance = await getEvmBalance(rpcUrl, fromAddress) } catch (e: any) {
      console.warn(`${TAG} Failed to fetch native balance via RPC: ${e.message}`)
    }
  }
  if (nativeBalance === undefined) {
    try {
      const bd = await pioneer.GetBalanceAddressByNetwork({ networkId: fromChain.networkId, address: fromAddress })
      const balStr = String(bd?.data?.nativeBalance || bd?.data?.balance || '0')
      nativeBalance = parseUnits(balStr, fromChain.decimals)
    } catch (e: any) {
      console.warn(`${TAG} Failed to fetch balance via Pioneer: ${e.message}`)
    }
  }
  if (nativeBalance === undefined) {
    throw new Error(`Unable to verify ${fromChain.symbol} balance for ${fromAddress} — refusing to build the swap. Check your connection and try again.`)
  }

  let approvalTxid: string | undefined

  if (isErc20Source) {
    // ── ERC-20 source swap: approve + depositWithExpiry ──

    // a) Token contract comes from the CAIP-19. CAIP is canonical — no
    //    separate contract param. Lowercased for internal Map keys (eth_call
    //    accepts either case).
    const tokenContract = (extractContractFromCaip(params.fromCaip) || '').toLowerCase()
    if (!tokenContract || !tokenContract.startsWith('0x')) {
      throw new Error(`Cannot extract token contract from CAIP: ${params.fromCaip}`)
    }

    // b) Get token decimals (direct RPC first, then Pioneer fallback)
    //    CRITICAL: Never silently default to 18 — wrong decimals cause catastrophic fund loss
    //    (e.g. USDC has 6 decimals; using 18 would send 10^12x the intended amount)
    let tokenDecimals: number | undefined
    if (rpcUrl) {
      try {
        tokenDecimals = await getErc20Decimals(rpcUrl, tokenContract)
        swapLog(`${TAG} Token decimals (direct RPC): ${tokenDecimals}`)
      } catch (e: any) {
        console.warn(`${TAG} Direct RPC decimals failed: ${e.message}, trying Pioneer...`)
        try {
          const decimalsResp = await pioneer.GetTokenDecimals({ networkId: fromChain.networkId, contractAddress: tokenContract })
          const d = Number(decimalsResp?.data?.decimals)
          if (!isNaN(d) && d >= 0 && d <= 36) tokenDecimals = d
        } catch { console.warn(`${TAG} Pioneer decimals also failed`) }
      }
    } else {
      try {
        const decimalsResp = await pioneer.GetTokenDecimals({ networkId: fromChain.networkId, contractAddress: tokenContract })
        const d = Number(decimalsResp?.data?.decimals)
        if (!isNaN(d) && d >= 0 && d <= 36) tokenDecimals = d
      } catch { console.warn(`${TAG} Pioneer decimals failed`) }
    }
    if (tokenDecimals === undefined) {
      throw new Error(
        `Cannot determine token decimals for ${tokenContract} on ${fromChain.id}. ` +
        `Refusing to proceed — wrong decimals cause catastrophic fund loss.`
      )
    }

    // c) Parse amount using TOKEN decimals (not chain's native 18)
    const amountBaseUnits = parseUnits(params.amount, tokenDecimals)
    swapLog(`${TAG} ERC-20 amount: ${amountBaseUnits} base units (${tokenDecimals} decimals)`)

    // Validate native balance covers gas for approve + deposit
    const approveGasLimit = 80000n
    const depositGasLimit = 200000n
    // For balance reservation: use the worst-case fee field (maxFeePerGas if EIP-1559)
    const effectiveFeePerGas = maxFeePerGas ?? gasPrice
    const totalGas = effectiveFeePerGas * (approveGasLimit + depositGasLimit)
    if (nativeBalance < totalGas) {
      throw new Error(
        `Insufficient ${fromChain.symbol} for gas: need ~${formatWei(totalGas)}, ` +
        `have ${formatWei(nativeBalance)}`
      )
    }

    // d) Check allowance + balance (parallel)
    let needsApproval = true
    let currentAllowanceWei = 0n
    let currentTokenBalance: bigint | null = null
    if (rpcUrl) {
      try {
        const [allowance, bal] = await Promise.all([
          getErc20Allowance(rpcUrl, tokenContract, fromAddress, routerAddress),
          getErc20Balance(rpcUrl, tokenContract, fromAddress).catch(() => null),
        ])
        currentAllowanceWei = allowance
        currentTokenBalance = bal
        needsApproval = currentAllowanceWei < amountBaseUnits
        swapLog(`${TAG} Current allowance: ${currentAllowanceWei}, needed: ${amountBaseUnits}, needsApproval: ${needsApproval}`)
        if (bal !== null) swapLog(`${TAG} Token balance: ${bal}, needed: ${amountBaseUnits}, sufficient: ${bal >= amountBaseUnits}`)
      } catch (e: any) {
        console.warn(`${TAG} Allowance/balance check failed, assuming approval needed: ${e.message}`)
      }
    }
    const allowanceInfo = {
      current: currentAllowanceWei.toString(),
      required: amountBaseUnits.toString(),
      sufficient: !needsApproval,
      spender: routerAddress,
      tokenContract,
    }
    const balanceInfo = currentTokenBalance !== null ? {
      current: currentTokenBalance.toString(),
      required: amountBaseUnits.toString(),
      sufficient: currentTokenBalance >= amountBaseUnits,
      tokenContract,
    } : undefined
    if (balanceInfo && !balanceInfo.sufficient && !previewMode) {
      throw new Error(`Insufficient ${tokenContract} balance: have ${currentTokenBalance!.toString()} units, need ${amountBaseUnits.toString()} units. The swap would revert on-chain — refusing to sign.`)
    }

    // e) If allowance insufficient, sign + broadcast approve tx
    //    H2 fix: approve exact amount (not MaxUint256) — safer for hardware wallet users
    let pendingApproveTx: any | undefined
    if (needsApproval) {
      const approveData = encodeApprove(routerAddress, amountBaseUnits)

      const approveTx: any = {
        chainId,
        addressNList: evmSigningPath,
        nonce: toHex(nonce),
        gasLimit: toHex(approveGasLimit),
        to: tokenContract,  // approve is called on the token contract
        value: '0x0',       // no ETH value
        data: approveData,
      }
      if (maxFeePerGas) {
        approveTx.maxFeePerGas = toHex(maxFeePerGas)
        approveTx.maxPriorityFeePerGas = toHex(maxPriorityFeePerGas!)
      } else {
        approveTx.gasPrice = toHex(gasPrice)
      }
      pendingApproveTx = approveTx

      // Preview mode: caller wants the unsigned txs without signing — project
      // the deposit nonce as if approval succeeded and skip device sign/broadcast.
      if (previewMode) {
        nonce += 1
      } else {
      swapLog(`${TAG} Signing ERC-20 approve tx: token=${tokenContract}, spender=${routerAddress}, amount=${amountBaseUnits}`)
      stage('approve-signing')
      const signedApprove = await wallet.ethSignTx(approveTx)

      // Extract serialized tx
      let approveHex: string
      if (typeof signedApprove === 'string') {
        approveHex = signedApprove
      } else if (signedApprove?.serializedTx) {
        approveHex = signedApprove.serializedTx
      } else if (signedApprove?.serialized) {
        approveHex = signedApprove.serialized
      } else {
        throw new Error('Failed to extract serialized approve tx')
      }
      if (!approveHex.startsWith('0x')) approveHex = '0x' + approveHex

      // Broadcast approve tx
      if (rpcUrl) {
        stage('approve-broadcasting')
        approvalTxid = await broadcastEvmTx(rpcUrl, approveHex, fromAddress)
        swapLog(`${TAG} Approve tx broadcast (direct RPC): ${approvalTxid}`)

        // Wait for approval receipt before building deposit — prevents nonce gap if approval reverts.
        // 180s tolerates busy mainnet (some hours: pending pool 30-60s, then mining).
        swapLog(`${TAG} Waiting for approval receipt (up to 180s)...`)
        stage('approve-waiting-receipt')
        const receipt = await waitForTxReceipt(rpcUrl, approvalTxid, 180_000)
        if (receipt && !receipt.status) {
          throw new Error(`ERC-20 approve tx reverted on-chain (txid: ${approvalTxid}). Swap aborted — no deposit was sent.`)
        }
        if (!receipt) {
          console.warn(`${TAG} Approval receipt not confirmed within 180s — proceeding with deposit (nonce gap risk)`)
        } else {
          swapLog(`${TAG} Approval confirmed on-chain (gas used: ${receipt.gasUsed})`)
        }
      } else {
        const approveResult = await pioneer.Broadcast({ networkId: fromChain.networkId, serialized: approveHex })
        approvalTxid = approveResult?.data?.txid || approveResult?.data?.tx_hash || approveResult?.data?.hash
        swapLog(`${TAG} Approve tx broadcast (Pioneer): ${approvalTxid}`)
        // No receipt check available without RPC — warn user
        console.warn(`${TAG} No direct RPC — cannot verify approval receipt. Proceeding with deposit.`)
      }

      nonce += 1
      } // end !previewMode
    }

    // f) Build depositWithExpiry with token contract as asset, value = 0x0
    const depositData = encodeDepositWithExpiry(
      params.inboundAddress, // vault address
      tokenContract,         // ERC-20 token contract (NOT zero address)
      amountBaseUnits,
      params.memo,
      expiry,
    )

    // Dynamic gas estimation with static fallback
    let erc20DepositGas = depositGasLimit
    if (rpcUrl) {
      erc20DepositGas = await estimateGas(rpcUrl, {
        to: routerAddress, from: fromAddress, data: depositData, value: '0x0',
      }, depositGasLimit)
      swapLog(`${TAG} Estimated deposit gas: ${erc20DepositGas} (fallback: ${depositGasLimit})`)
    }

    const unsignedTx: any = {
      chainId,
      addressNList: evmSigningPath,
      nonce: toHex(nonce),
      gasLimit: toHex(erc20DepositGas),
      to: routerAddress,     // ROUTER contract, NOT vault
      value: '0x0',          // no ETH value for ERC-20 swaps
      data: depositData,
    }
    if (maxFeePerGas) {
      unsignedTx.maxFeePerGas = toHex(maxFeePerGas)
      unsignedTx.maxPriorityFeePerGas = toHex(maxPriorityFeePerGas!)
    } else {
      unsignedTx.gasPrice = toHex(gasPrice)
    }

    swapLog(`${TAG} ERC-20 router call: to=${routerAddress}, vault=${params.inboundAddress}, token=${tokenContract}, amount=${amountBaseUnits}`)
    return { unsignedTx, approvalTxid, approveTx: pendingApproveTx, allowance: allowanceInfo, balance: balanceInfo }

  } else {
    // ── Native asset swap: asset = 0x0, value = amountWei ──
    let amountWei = parseUnits(params.amount, fromChain.decimals)
    const staticGasLimit = DEPOSIT_GAS_LIMITS[fromChain.id] || 120000n

    // Dynamic gas estimation with static fallback (use static for initial estimate)
    let gasLimit = staticGasLimit

    // Reservation uses worst-case fee per gas (maxFeePerGas if EIP-1559, else gasPrice)
    const reservedGasPrice = maxFeePerGas ?? gasPrice
    const gasFee = reservedGasPrice * gasLimit

    // sendMax: deduct gas from send amount so the entire balance is used
    if (params.isMax && nativeBalance > gasFee) {
      amountWei = nativeBalance - gasFee
      swapLog(`${TAG} sendMax: adjusted amount to ${formatWei(amountWei)} ${fromChain.symbol} (balance ${formatWei(nativeBalance)} - gas ${formatWei(gasFee)})`)
    }

    const data = encodeDepositWithExpiry(
      params.inboundAddress, // vault address
      ZERO_ADDRESS,          // native asset (not ERC-20)
      amountWei,
      params.memo,
      expiry,
    )

    // Refine gas estimate now that we have the calldata
    if (rpcUrl) {
      try {
        gasLimit = await estimateGas(rpcUrl, {
          to: routerAddress, from: fromAddress, data, value: toHex(amountWei),
        }, staticGasLimit)
        swapLog(`${TAG} Estimated native deposit gas: ${gasLimit} (fallback: ${staticGasLimit})`)
      } catch (e: any) {
        console.warn(`${TAG} Gas estimation failed, using static fallback ${staticGasLimit}: ${e.message}`)
        gasLimit = staticGasLimit
      }
    }

    const finalGasFee = reservedGasPrice * gasLimit

    // L2 chains (OP Stack): reserve extra for L1 data posting fee, which is separate from
    // gasPrice * gasLimit. Without this, sendMax overspends by the L1 fee and gets rejected.
    const L2_DATA_FEE_CHAINS = ['base', 'optimism', 'arbitrum']
    const l1DataFeeBuffer = L2_DATA_FEE_CHAINS.includes(fromChain.id) ? BigInt(5e13) : 0n // 0.00005 ETH
    const totalGasReserve = finalGasFee + l1DataFeeBuffer

    // Re-adjust for sendMax with refined gas estimate + L1 data fee buffer
    if (params.isMax && nativeBalance > totalGasReserve) {
      amountWei = nativeBalance - totalGasReserve
      if (l1DataFeeBuffer > 0n) swapLog(`${TAG} sendMax includes L1 data fee buffer: ${formatWei(l1DataFeeBuffer)}`)
    }

    if (nativeBalance < amountWei + totalGasReserve) {
      throw new Error(
        `Insufficient ${fromChain.symbol}: need ${formatWei(amountWei + totalGasReserve)}, ` +
        `have ${formatWei(nativeBalance)}`
      )
    }

    // Rebuild calldata with final amount
    const finalData = encodeDepositWithExpiry(
      params.inboundAddress,
      ZERO_ADDRESS,
      amountWei,
      params.memo,
      expiry,
    )

    const unsignedTx: any = {
      chainId,
      addressNList: evmSigningPath,
      nonce: toHex(nonce),
      gasLimit: toHex(gasLimit),
      to: routerAddress,         // ROUTER contract, NOT vault
      value: toHex(amountWei),   // ETH value sent with the call
      data: finalData,           // depositWithExpiry encoded call
    }
    if (maxFeePerGas) {
      unsignedTx.maxFeePerGas = toHex(maxFeePerGas)
      unsignedTx.maxPriorityFeePerGas = toHex(maxPriorityFeePerGas!)
    } else {
      unsignedTx.gasPrice = toHex(gasPrice)
    }

    swapLog(`${TAG} EVM native router call: to=${routerAddress}, vault=${params.inboundAddress}, value=${formatWei(amountWei)} ${fromChain.symbol}${params.isMax ? ' (sendMax)' : ''}`)
    return { unsignedTx }
  }
}
