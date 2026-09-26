export const LARGE_TRADE_USD = 1000

/** THORChain's LIM is always in 1e8 units, including ETH. Only decode a
 * simple asset swap: aggregator memos have different output semantics. */
export function thorMemoMinimum(memo: string): number | undefined {
  const fields = memo.split(':')
  if (!/^(=|s|swap)$/i.test(fields[0]) || fields.length > 6) return undefined
  const raw = (fields[3] || '').split('/')[0]
  if (!raw) return 0 // no price limit encoded
  if (!/^\d+(?:e\d+)?$/i.test(raw)) return undefined
  const n = Number(raw) / 1e8
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export function assessSwapRisk(input: {
  inputAmount: number; expectedAmount: number; minimumAmount: number
  fromPriceUsd: number; toPriceUsd: number; sameAssetUnits: boolean
}) {
  const positive = (n: number) => Number.isFinite(n) && n > 0
  const inputUsd = positive(input.inputAmount) && positive(input.fromPriceUsd) ? input.inputAmount * input.fromPriceUsd : undefined
  const tier = inputUsd === undefined ? 'unknown' : inputUsd >= LARGE_TRADE_USD ? 'large' : 'small'
  const comparable = input.sameAssetUnits || (positive(input.fromPriceUsd) && positive(input.toPriceUsd))
  const unitPrice = input.sameAssetUnits ? input.fromPriceUsd : input.toPriceUsd
  const inputValue = input.sameAssetUnits ? input.inputAmount : input.inputAmount * input.fromPriceUsd
  const expectedValue = input.sameAssetUnits ? input.expectedAmount : input.expectedAmount * input.toPriceUsd
  const minimumValue = input.sameAssetUnits ? input.minimumAmount : input.minimumAmount * input.toPriceUsd
  const measurable = comparable && positive(inputValue) && positive(expectedValue)
  const expectedLossPct = measurable ? Math.max(0, (1 - expectedValue / inputValue) * 100) : undefined
  const minimumValid = Number.isFinite(input.minimumAmount) && input.minimumAmount >= 0 && input.minimumAmount <= input.expectedAmount
  const minimumLossPct = measurable && minimumValid ? Math.max(0, (1 - minimumValue / inputValue) * 100) : undefined
  const expectedLossUsd = inputUsd !== undefined && expectedLossPct !== undefined ? inputUsd * expectedLossPct / 100 : undefined
  const minimumLossUsd = inputUsd !== undefined && minimumLossPct !== undefined ? inputUsd * minimumLossPct / 100 : undefined
  const allowancePct = positive(input.expectedAmount) && minimumValid ? (1 - input.minimumAmount / input.expectedAmount) * 100 : undefined
  const blocked = tier === 'large' && expectedLossPct !== undefined && expectedLossPct >= 5 - 1e-9
  const warning = expectedLossPct !== undefined && expectedLossPct >= (tier === 'small' ? 10 : 0.5) - 1e-9
  const requiresAcknowledgment = !blocked && (tier === 'unknown' || (tier === 'large' &&
    (expectedLossPct === undefined || minimumLossPct === undefined || expectedLossPct >= 1 - 1e-9 || minimumLossPct >= 2 - 1e-9)))
  return { tier, inputUsd, expectedLossPct, minimumLossPct, expectedLossUsd, minimumLossUsd,
    allowancePct, blocked, warning, requiresAcknowledgment,
    expectedUsd: positive(unitPrice) ? input.expectedAmount * unitPrice : undefined,
    minimumUsd: minimumValid && positive(unitPrice) ? input.minimumAmount * unitPrice : undefined,
    quoteMaxAgeMs: tier === 'small' ? 60_000 : 30_000 }
}

export type SwapRisk = ReturnType<typeof assessSwapRisk>
