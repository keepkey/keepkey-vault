/**
 * True when a raw balance string/number represents a non-zero holding.
 *
 * Use this — never `balanceUsd > 0` — to decide whether a chain or account
 * "has funds". A missing or failed price feed leaves balanceUsd at 0 while the
 * user still holds tokens; gating on USD then renders real funds as
 * "No balance yet", which reads as lost money. USD is presentation only.
 */
export function hasNonZeroBalance(val: string | number | null | undefined): boolean {
	if (val === null || val === undefined) return false
	const num = typeof val === 'number' ? val : parseFloat(val)
	return Number.isFinite(num) && num > 0
}

/** Format a crypto balance for display. Accepts an optional locale for number separators. */
export function formatBalance(val: string, locale?: string): string {
	const num = parseFloat(val)
	if (isNaN(num) || num === 0) return '0'
	const abs = Math.abs(num)
	const sign = num < 0 ? '-' : ''
	if (abs < 0.000001) return num.toExponential(2)
	if (abs < 1) return sign + abs.toFixed(6)
	if (abs < 1000) return sign + abs.toFixed(4)
	return sign + abs.toLocaleString(locale || 'en-US', { maximumFractionDigits: 2 })
}
