/** Shared locale validation; safe in both the desktop backend and the WebView. */
export function validNumberLocale(value: unknown): string {
  if (typeof value === 'string' && value.length <= 64) {
    try {
      const [locale] = Intl.getCanonicalLocales(value)
      if (locale && Intl.NumberFormat.supportedLocalesOf([locale]).length) return locale
    } catch { /* Invalid persisted preference. */ }
  }
  return 'en-US'
}

/**
 * Amount fields accept ungrouped decimals, never a numeric prefix. Keep values
 * as strings so long cryptocurrency amounts are not rounded by Number parsing.
 * A locale's comma decimal separator is accepted alongside canonical ASCII dot.
 * Grouping, mixed separators, exponents, signs and non-finite values are rejected.
 */
export function normalizeAmountInput(value: string, locale = 'en-US'): string | null {
  let input = value.trim()
  const decimal = new Intl.NumberFormat(validNumberLocale(locale)).formatToParts(1.1).find(p => p.type === 'decimal')?.value
  if (decimal === ',' && input.includes(',')) {
    if (input.includes('.')) return null
    input = input.replace(',', '.')
  }
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(input)) return null
  return input.startsWith('.') ? `0${input}` : input
}

/** Expand internally computed numbers without allowing exponent syntax in input. */
export function decimalAmount(value: number, significantDigits = 8): string {
  if (!Number.isFinite(value) || value < 0) return ''
  if (value >= 1 && value < 1e21) return value.toFixed(significantDigits).replace(/\.?0+$/, '')
  return value.toLocaleString('en-US', value < 1
    ? { useGrouping: false, maximumSignificantDigits: significantDigits }
    : { useGrouping: false, maximumFractionDigits: significantDigits })
}
