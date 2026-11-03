import type { SwapQuote } from '../shared/types'

/** Prefer transactions the connected device can describe, then compare output.
 * A failed lookup never grants review support. The final signing gate remains
 * authoritative, including for approvals and devices changed after quoting. */
export async function selectSwapRoute(
  quotes: SwapQuote[],
  canReview: (quote: SwapQuote) => Promise<boolean | 'source-deposit'>,
): Promise<SwapQuote> {
  if (!quotes.length) throw new Error('No quotes available for this pair')
  const reviewed = await Promise.all(quotes.map(async quote => {
    try { return { quote, reviewable: await canReview(quote) } }
    catch { return { quote, reviewable: false } }
  }))
  const rank = (review: boolean | 'source-deposit') => review === true ? 2 : review === 'source-deposit' ? 1 : 0
  reviewed.sort((a, b) => rank(b.reviewable) - rank(a.reviewable)
    || Number(b.quote.expectedOutput) - Number(a.quote.expectedOutput))
  return reviewed[0].quote
}

/** A source deposit binds the order id and input; destination terms are off
 * chain. This label is inferred from calldata, never a provider's metadata. */
export function isRelaySolverDeposit(quote: SwapQuote): boolean {
  const tx = quote.relayTx
  if (!tx || String(tx.to).toLowerCase() !== '0x4cd00e387622c35bddb9b4c962c136462338bc31') return false
  const data = String(tx.data).toLowerCase()
  return /^0x[0-9a-f]+$/.test(data) && (
    (data.startsWith('0x49290c1c') && data.length === 138)
    || (data.startsWith('0xe8017952') && data.length === 266)
  )
}
