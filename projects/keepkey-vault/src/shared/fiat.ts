import type { FiatCurrency } from './types'

export interface FiatConfig {
  code: FiatCurrency
  symbol: string
  name: string
  locale: string      // default Intl locale for this currency
  decimals: number     // typically 2, JPY/KRW = 0
}

export const FIAT_CURRENCIES: FiatConfig[] = [
  { code: 'USD', symbol: '$',   name: 'US Dollar',          locale: 'en-US',  decimals: 2 },
  { code: 'EUR', symbol: '\u20AC',  name: 'Euro',               locale: 'de-DE',  decimals: 2 },
  { code: 'GBP', symbol: '\u00A3',  name: 'British Pound',      locale: 'en-GB',  decimals: 2 },
  { code: 'JPY', symbol: '\u00A5',  name: 'Japanese Yen',       locale: 'ja-JP',  decimals: 0 },
  { code: 'CHF', symbol: 'CHF', name: 'Swiss Franc',        locale: 'de-CH',  decimals: 2 },
  { code: 'CAD', symbol: 'CA$', name: 'Canadian Dollar',    locale: 'en-CA',  decimals: 2 },
  { code: 'AUD', symbol: 'A$',  name: 'Australian Dollar',  locale: 'en-AU',  decimals: 2 },
  { code: 'CNY', symbol: '\u00A5',  name: 'Chinese Yuan',       locale: 'zh-CN',  decimals: 2 },
  { code: 'KRW', symbol: '\u20A9',  name: 'South Korean Won',   locale: 'ko-KR',  decimals: 0 },
  { code: 'BRL', symbol: 'R$',  name: 'Brazilian Real',     locale: 'pt-BR',  decimals: 2 },
  { code: 'RUB', symbol: '\u20BD',  name: 'Russian Ruble',      locale: 'ru-RU',  decimals: 2 },
  { code: 'INR', symbol: '\u20B9',  name: 'Indian Rupee',       locale: 'en-IN',  decimals: 2 },
  { code: 'MXN', symbol: 'MX$', name: 'Mexican Peso',       locale: 'es-MX',  decimals: 2 },
  { code: 'SEK', symbol: 'kr',  name: 'Swedish Krona',      locale: 'sv-SE',  decimals: 2 },
  { code: 'NOK', symbol: 'kr',  name: 'Norwegian Krone',    locale: 'nb-NO',  decimals: 2 },
  { code: 'DKK', symbol: 'kr',  name: 'Danish Krone',       locale: 'da-DK',  decimals: 2 },
  { code: 'PLN', symbol: 'z\u0142',  name: 'Polish Zloty',       locale: 'pl-PL',  decimals: 2 },
  { code: 'CZK', symbol: 'K\u010D',  name: 'Czech Koruna',       locale: 'cs-CZ',  decimals: 2 },
  { code: 'HUF', symbol: 'Ft',  name: 'Hungarian Forint',   locale: 'hu-HU',  decimals: 0 },
  { code: 'TRY', symbol: '\u20BA',  name: 'Turkish Lira',       locale: 'tr-TR',  decimals: 2 },
]

export function getFiatConfig(code: FiatCurrency): FiatConfig {
  return FIAT_CURRENCIES.find(c => c.code === code) || FIAT_CURRENCIES[0]
}

/**
 * Format a fiat value with locale-aware separators and currency symbol.
 * All prices in the app are stored as USD — this applies a conversion rate.
 */
export function formatFiat(
  usdValue: number | string | null | undefined,
  currency: FiatCurrency,
  locale: string,
  conversionRate = 1,
): string {
  if (usdValue === null || usdValue === undefined) return ''
  const num = (typeof usdValue === 'string' ? parseFloat(usdValue) : usdValue) * conversionRate
  if (!isFinite(num)) return ''
  const cfg = getFiatConfig(currency)
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: cfg.decimals,
      maximumFractionDigits: cfg.decimals,
    }).format(num)
  } catch {
    // Fallback if locale not supported
    return `${cfg.symbol}${num.toFixed(cfg.decimals)}`
  }
}

/**
 * Format a fiat value compactly (no currency name, just symbol + number).
 * For inline display next to crypto amounts.
 */
export function formatFiatCompact(
  usdValue: number | string | null | undefined,
  currency: FiatCurrency,
  locale: string,
  conversionRate = 1,
): string {
  if (usdValue === null || usdValue === undefined) return ''
  const num = (typeof usdValue === 'string' ? parseFloat(usdValue) : usdValue) * conversionRate
  if (!isFinite(num) || num === 0) return ''
  const cfg = getFiatConfig(currency)
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: cfg.decimals,
      maximumFractionDigits: cfg.decimals,
      currencyDisplay: 'narrowSymbol',
    }).format(num)
  } catch {
    return `${cfg.symbol}${num.toFixed(cfg.decimals)}`
  }
}
