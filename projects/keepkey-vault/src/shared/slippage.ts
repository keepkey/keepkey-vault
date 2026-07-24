export const MIN_SLIPPAGE_BPS = 10
export const MAX_SLIPPAGE_BPS = 5000
export const DEFAULT_SLIPPAGE_BPS = 100
export const SLIPPAGE_PRESETS_BPS = [50, 100, 300] as const

export function normalizeSlippageBps(value: unknown, fallback = DEFAULT_SLIPPAGE_BPS): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(MIN_SLIPPAGE_BPS, Math.min(MAX_SLIPPAGE_BPS, Math.round(parsed)))
}

export type CustomSlippageParseResult =
  | { ok: true; bps: number }
  | { ok: false; error: string }

/** Parse the human-facing percentage used by the inline Custom slippage field. */
export function parseCustomSlippagePercent(value: string): CustomSlippageParseResult {
  const trimmed = value.trim()
  if (!trimmed) return { ok: false, error: 'Enter a slippage percentage.' }
  const percentage = Number(trimmed)
  if (!Number.isFinite(percentage)) {
    return { ok: false, error: 'Enter a valid percentage.' }
  }
  if (percentage < MIN_SLIPPAGE_BPS / 100 || percentage > MAX_SLIPPAGE_BPS / 100) {
    return {
      ok: false,
      error: `Enter a percentage between ${MIN_SLIPPAGE_BPS / 100} and ${MAX_SLIPPAGE_BPS / 100}.`,
    }
  }
  return { ok: true, bps: normalizeSlippageBps(percentage * 100) }
}
