/** Format a crypto balance for display. */
export function formatBalance(val: string): string {
	const num = parseFloat(val)
	if (isNaN(num) || num === 0) return '0'
	if (num < 0.000001) return num.toExponential(2)
	if (num < 1) return num.toFixed(6)
	if (num < 1000) return num.toFixed(4)
	return num.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

/** Format a USD value for display (e.g. "1,234.56"). */
export function formatUsd(value: number | string | null | undefined): string {
	if (value === null || value === undefined) return '0.00'
	const num = typeof value === 'string' ? parseFloat(value) : value
	if (!isFinite(num)) return '0.00'
	return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
