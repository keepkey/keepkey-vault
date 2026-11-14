export const MIN_SLIPPAGE_BPS = 10
export const MAX_SLIPPAGE_BPS = 5000
export const DEFAULT_SLIPPAGE_BPS = 100
export const SLIPPAGE_PRESETS_BPS = [50, 100, 300] as const
/** Only tolerances up to this are remembered between swaps (audit v4 V1). */
export const PERSIST_MAX_SLIPPAGE_BPS = 300
/** Above this, the review asks for an explicit confirmation before signing. */
export const CONFIRM_SLIPPAGE_BPS = 500

/** After a swap a preset stays selected; a custom tolerance returns to the default. */
export function slippageAfterSwap(bps: number): number {
  return (SLIPPAGE_PRESETS_BPS as readonly number[]).includes(bps) ? bps : DEFAULT_SLIPPAGE_BPS
}

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
