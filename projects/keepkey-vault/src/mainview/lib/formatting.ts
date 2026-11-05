import { getNumberLocale } from './number-locale'
import { validNumberLocale } from '../../shared/locale'

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
export function formatBalance(val: string, locale = getNumberLocale()): string {
	const num = parseFloat(val)
	if (isNaN(num) || num === 0) return '0'
	const abs = Math.abs(num)
	const resolvedLocale = validNumberLocale(locale)
	if (abs < 0.000001) return num.toLocaleString(resolvedLocale, { notation: 'scientific', maximumFractionDigits: 2 })
	const decimals = abs < 1 ? 6 : abs < 1000 ? 4 : 2
	return num.toLocaleString(resolvedLocale, { minimumFractionDigits: abs < 1000 ? decimals : 0, maximumFractionDigits: decimals })
}
