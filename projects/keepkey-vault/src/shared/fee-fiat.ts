/**
 * USD value of a built transaction's network fee, for the send review.
 *
 * The fee is always paid in the chain's native asset (ETH for an ERC-20 send),
 * so it is priced with the native asset's price, the same one the review's
 * "fee over 25%" warning uses. It comes from the cached balance, so the review
 * makes no network call for it. Any missing piece (no price, a zero or
 * unreadable fee) yields undefined: no USD figure, never a "$0" that reads as
 * a free transaction.
 */
export function feeUsdFromNative(fee: string | undefined, nativeUnitPriceUsd: number): number | undefined {
  const amount = Number(fee)
  if (!fee || !Number.isFinite(amount) || amount <= 0) return undefined
  if (!Number.isFinite(nativeUnitPriceUsd) || nativeUnitPriceUsd <= 0) return undefined
  return amount * nativeUnitPriceUsd
}

/**
 * Review label for a fee in USD. A positive fee under one cent (most L2 sends)
 * would round to "$0.00", which reads as free; show "<$0.01" instead, as the
 * Activity panel does. Empty when there is no figure.
 */
export function feeFiatLabel(feeUsd: number | undefined, fmtCompact: (usd: number) => string): string {
  if (feeUsd === undefined || !Number.isFinite(feeUsd) || feeUsd <= 0) return ''
  if (feeUsd >= 0.01) return fmtCompact(feeUsd)
  // Never a bare "<" when the formatter has nothing to print.
  const floor = fmtCompact(0.01)
  return floor ? `<${floor}` : ''
}
