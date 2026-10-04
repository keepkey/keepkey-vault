/**
 * Pure derivation for swap warning surfaces (dust-fee + high-slippage).
 *
 * Kept side-effect-free and dependency-free so the same logic is testable in
 * isolation and could later be reused server-side. UI is responsible for
 * rendering — these helpers only decide what the warning *says*.
 */

/** % of input value lost to fees+spread before we surface a warning at all. */
export const DUST_FEE_WARNING_PCT = 10
/** % of input value lost to fees+spread that escalates to "severe" styling. */
export const DUST_FEE_SEVERE_PCT = 25
/** Effective slippage % above which we warn the user. Effective = max(market, tolerance). */
export const HIGH_SLIPPAGE_PCT = 3

export type LargeSwapLossWarning = {
  lossPct: number
  /** Loss in destination units when both assets represent the same coin. */
  lostAsset?: number
  /** Only present when an independent market price is available. */
  lostUsd?: number
  severe: boolean
}

/** Compare a quote with independent prices, or directly compare units for
 * native ETH across EVM chains. A price inferred from the quote must never be
 * passed here: it makes every quote appear to have zero loss. */
export function computeLargeSwapLossWarning(input: {
  inAmount: number
  outAmount: number
  fromPriceUsd?: number
  toPriceUsd?: number
  sameAssetUnits?: boolean
}): LargeSwapLossWarning | null {
  const { inAmount, outAmount, fromPriceUsd = 0, toPriceUsd = 0, sameAssetUnits = false } = input
  if (!Number.isFinite(inAmount) || !Number.isFinite(outAmount) || inAmount <= 0 || outAmount <= 0) return null
  const hasFromPrice = Number.isFinite(fromPriceUsd) && fromPriceUsd > 0
  const hasToPrice = Number.isFinite(toPriceUsd) && toPriceUsd > 0
  if (!sameAssetUnits && (!hasFromPrice || !hasToPrice)) return null
  const inValue = sameAssetUnits ? inAmount : inAmount * fromPriceUsd
  const outValue = sameAssetUnits ? outAmount : outAmount * toPriceUsd
  const lossPct = ((inValue - outValue) / inValue) * 100
  if (!Number.isFinite(lossPct) || lossPct < 0.5) return null
  const lostAsset = sameAssetUnits ? inAmount - outAmount : undefined
  const lostUsd = sameAssetUnits
    ? hasFromPrice ? lostAsset! * fromPriceUsd : undefined
    : inValue - outValue
  // Warn on a meaningful dollar loss even when the percentage is below the
  // old 10% dust threshold. Without USD, a 2% same-asset loss still warrants
  // a warning; we cannot infer a dollar amount from the quote itself.
  if (!(lostUsd !== undefined && lostUsd >= 100) && lossPct < 2) return null
  return { lossPct, lostAsset, lostUsd, severe: lossPct >= 3 || (lostUsd !== undefined && lostUsd >= 1000) }
}

/** Quote guard emitted when fixed route fees consume the selected slippage
 * allowance. This is an expected small-swap constraint, not an application
 * failure, so callers should render it as advisory/warning UI. */
export function isSmallSwapQuoteWarning(message?: string | null): boolean {
  return /^Swap amount too low:\s*quoted fees\b/i.test(message?.trim() || '')
}

export type DustWarning = {
  severe: boolean
  /** % of input lost to fees+spread (0–100) */
  lossPct: number
  /** USD value of input */
  inUsd: number
  /** USD value lost (inUsd - outUsd) */
  lostUsd: number
  /** Suggested minimum input USD for non-dust swap (severe tier only) */
  recommendedMinUsd: number
}

/** Compute a dust-fee warning from displayed in/out USD values. Returns null
 *  when no warning should fire (insufficient data, profitable swap, sub-threshold loss).
 *  Inputs are taken from the same numbers shown to the user, so msg.value EVM
 *  fees and protocol spread are captured implicitly — not just quote.fees. */
export function computeDustWarning(input: {
  inAmount: number
  outAmount: number
  fromPriceUsd: number
  toPriceUsd: number
}): DustWarning | null {
  const { inAmount, outAmount, fromPriceUsd, toPriceUsd } = input
  if (!Number.isFinite(inAmount) || !Number.isFinite(outAmount)) return null
  if (!Number.isFinite(fromPriceUsd) || !Number.isFinite(toPriceUsd)) return null
  const inUsd = inAmount * fromPriceUsd
  const outUsd = outAmount * toPriceUsd
  if (inUsd <= 0 || outUsd <= 0) return null
  const lossPct = ((inUsd - outUsd) / inUsd) * 100
  if (lossPct < DUST_FEE_WARNING_PCT) return null
  return {
    severe: lossPct > DUST_FEE_SEVERE_PCT,
    lossPct,
    inUsd,
    lostUsd: inUsd - outUsd,
    recommendedMinUsd: Math.ceil(inUsd * 4),
  }
}

/** Effective slippage for the warning surface. The market slippage Pioneer
 *  observed (quote.slippageBps) is often <1% even when the user has set a 5%
 *  tolerance — so checking only the quote misses the user-set risk. Take the
 *  max of both and warn against that. */
export function computeEffectiveSlippageBps(quoteSlippageBps: number, userSlippageBps: number): number {
  const q = Number.isFinite(quoteSlippageBps) ? Math.max(0, quoteSlippageBps) : 0
  const u = Number.isFinite(userSlippageBps) ? Math.max(0, userSlippageBps) : 0
  return Math.max(q, u)
}

/** Boolean form of the slippage warning. Threshold is HIGH_SLIPPAGE_PCT. */
export function shouldWarnHighSlippage(quoteSlippageBps: number, userSlippageBps: number): boolean {
  return computeEffectiveSlippageBps(quoteSlippageBps, userSlippageBps) / 100 > HIGH_SLIPPAGE_PCT
}
