/** Extract a USD quote from every GetMarketInfo response shape seen in production. */
export function marketPriceUsd(response: any): number {
  // pioneer-client returns `{ data: result.body }`, while the HTTP body itself
  // is `{ data: [price], success: true }`. Unwrap those transport envelopes
  // before accepting either today's numeric row or the older object row.
  let row = response
  for (let depth = 0; depth < 3 && row && !Array.isArray(row) && typeof row === 'object' && 'data' in row; depth++) {
    row = row.data
  }
  if (Array.isArray(row)) row = row[0]
  const raw = typeof row === 'number' || typeof row === 'string'
    ? row
    : (row?.priceUsd ?? row?.price ?? row?.valueUsd ?? 0)
  const price = Number(raw)
  return Number.isFinite(price) && price > 0 ? price : 0
}
