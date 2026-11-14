/** Custom gas-price bound errors: thrown in English by the EVM builder, shown translated by the UI. */
import { decimalAmount } from './locale'
export const GAS_PRICE_ERROR = {
  tooHigh: 'Gas price is 10x or more the network price',
  tooLow: 'Gas price is below the network base fee',
  quoteUnavailable: 'The network gas price could not be loaded',
} as const

const KEYS: Record<keyof typeof GAS_PRICE_ERROR, string> = {
  tooHigh: 'customGasPriceTooHigh',
  tooLow: 'customGasPriceTooLow',
  quoteUnavailable: 'customGasPriceUnavailable',
}

/** The send-namespace message for a builder gas-price error, or null for any other error. */
export function describeGasPriceError(message: string, t: (key: any, options?: any) => any): string | null {
  for (const [kind, prefix] of Object.entries(GAS_PRICE_ERROR) as [keyof typeof GAS_PRICE_ERROR, string][]) {
    if (!message.startsWith(prefix)) continue
    const gwei = message.match(/\(~?([\d.]+) gwei\)/)?.[1]
    return t(KEYS[kind], { ns: 'send', gwei })
  }
  return null
}

/** The average network gas price in gwei from a `getFees` EVM answer, or null when there is none. */
export function networkGasPriceGwei(gasPrice: unknown): string | null {
  const raw = gasPrice && typeof gasPrice === 'object' ? ((gasPrice as any).average ?? (gasPrice as any).fast) : gasPrice
  const n = parseFloat(String(raw ?? ''))
  return Number.isFinite(n) && n > 0 ? decimalAmount(n, 4) : null
}
