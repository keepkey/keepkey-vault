/** Format a crypto balance for display. */
export function formatBalance(val: string): string {
	const num = parseFloat(val)
	if (isNaN(num) || num === 0) return '0'
	if (num < 0.000001) return num.toExponential(2)
	if (num < 1) return num.toFixed(6)
	if (num < 1000) return num.toFixed(4)
	return num.toLocaleString(undefined, { maximumFractionDigits: 2 })
}
