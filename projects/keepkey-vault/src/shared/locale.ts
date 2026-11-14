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

const decimalSeparator = (locale: string) =>
  new Intl.NumberFormat(validNumberLocale(locale)).formatToParts(1.1).find(p => p.type === 'decimal')?.value

/**
 * Amount fields accept ungrouped decimals, never a numeric prefix. Keep values
 * as strings so long cryptocurrency amounts are not rounded by Number parsing.
 * A comma decimal separator is accepted alongside canonical ASCII dot when the
 * number locale or the UI language (whose hints show "1,5") uses one.
 * Grouping, mixed separators, exponents, signs and non-finite values are rejected.
 */
export function normalizeAmountInput(value: string, locale = 'en-US', language?: string): string | null {
  let input = value.trim()
  const commaDecimal = decimalSeparator(locale) === ',' || (!!language && decimalSeparator(language) === ',')
  if (commaDecimal && input.includes(',')) {
    if (input.includes('.')) return null
    // Only the UI language reads the comma as decimal: the number format still
    // groups with it ("1,234.56"), so "1,234" is ambiguous and refused.
    if (decimalSeparator(locale) !== ',' && /^\d+,\d{3}$/.test(input)) return null
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
