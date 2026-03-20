/** Format a crypto balance for display. */
export function formatBalance(val: string): string {
	const num = parseFloat(val)
	if (isNaN(num) || num === 0) return '0'
	const abs = Math.abs(num)
	const sign = num < 0 ? '-' : ''
	if (abs < 0.000001) return num.toExponential(2)
	if (abs < 1) return sign + abs.toFixed(6)
	if (abs < 1000) return sign + abs.toFixed(4)
	return sign + abs.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

/** Format a USD value for display (e.g. "1,234.56"). Legacy — prefer useFiat().fmt() */
export function formatUsd(value: number | string | null | undefined): string {
	if (value === null || value === undefined) return '0.00'
	const num = typeof value === 'string' ? parseFloat(value) : value
	if (!isFinite(num)) return '0.00'
	return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
