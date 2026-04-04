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
