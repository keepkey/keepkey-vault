/** CSV cells for files users open in Excel, Numbers or Sheets. */

/** Quote a cell, double inner quotes, and neutralize formulas: a value starting with = + - @ (or a tab or line break)
 *  gets a leading ' so a spreadsheet shows it as text instead of running it. */
export function csvCell(value: unknown): string {
	let s = String(value ?? '').replace(/"/g, '""')
	const trimmed = s.trimStart()
	if (/^[=+\-@\t\r\n]/.test(trimmed)) s = `'${s}`
	return `"${s}"`
}

/** A plain decimal number stays a number (negative amounts must not turn into text); anything else is a csvCell. */
export function csvNumber(value: unknown): string {
	const s = String(value ?? '')
	return /^-?\d+(\.\d+)?$/.test(s) ? s : csvCell(value)
}
