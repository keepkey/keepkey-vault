/** Dust errors: thrown in English by the UTXO builder, shown translated by the UI. */
import { validNumberLocale } from './locale'

export const DUST_ERROR = {
  amount: 'Amount is below the network dust limit',
  maxAfterFees: 'After fees, the amount to send is below the network dust limit',
} as const

const KEYS: Record<keyof typeof DUST_ERROR, string> = {
  amount: 'amountBelowDust',
  maxAfterFees: 'maxBelowDust',
}

/** "0.00000546" for 546 base units at 8 decimals, never exponent notation. */
export function formatBaseUnits(value: number, decimals: number): string {
  const fixed = (value / 10 ** decimals).toFixed(decimals)
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed
}

/** The builder's message: `<prefix> (minimum 0.00000546 BTC)`. */
export function dustErrorMessage(kind: keyof typeof DUST_ERROR, minimum: string, symbol: string): string {
  return `${DUST_ERROR[kind]} (minimum ${minimum} ${symbol})`
}

/** "0,00000546" in pt-BR: every decimal of the minimum kept, so it is never rounded below the limit. */
function localizeMinimum(minimum: string, locale: string): string {
  const decimals = minimum.split('.')[1]?.length ?? 0
  return Number(minimum).toLocaleString(validNumberLocale(locale), { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/** The send-namespace message for a builder dust error, or null for any other error. */
export function describeDustError(message: string, t: (key: any, options?: any) => any, locale = 'en-US'): string | null {
  for (const [kind, prefix] of Object.entries(DUST_ERROR) as [keyof typeof DUST_ERROR, string][]) {
    if (!message.startsWith(prefix)) continue
    const match = message.match(/\(minimum (\d+(?:\.\d+)?) ([^)\s]+)\)/)
    if (!match) return null // not the builder's shape: show the raw text rather than a blank minimum
    return t(KEYS[kind], { ns: 'send', minimum: localizeMinimum(match[1], locale), symbol: match[2] })
  }
  return null
}
