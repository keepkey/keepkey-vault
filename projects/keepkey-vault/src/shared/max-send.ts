export const TOKEN_MAX_DISPLAY_DECIMALS = 8
const MAX_SAFE_DECIMALS = 255

export function normalizeDecimals(decimals: unknown): number | null {
  const value = typeof decimals === 'number'
    ? decimals
    : typeof decimals === 'string' && decimals.trim() !== ''
      ? Number(decimals)
      : NaN
  if (!Number.isInteger(value) || value < 0 || value > MAX_SAFE_DECIMALS) return null
  return value
}

export function decimalToBaseUnits(amount: string, decimals: unknown): bigint | null {
  const precision = normalizeDecimals(decimals)
  if (precision === null) return null
  const normalized = String(amount || '').trim()
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return null

  const [whole = '0', fraction = ''] = normalized.split('.')
  const scale = 10n ** BigInt(precision)
  const fractionalUnits = (fraction || '').slice(0, precision).padEnd(precision, '0')
  return BigInt(whole) * scale + BigInt(fractionalUnits || '0')
}

export function decimalToBaseUnitsStrict(amount: string, decimals: unknown): bigint {
  const units = decimalToBaseUnits(amount, decimals)
  if (units === null) throw new Error(`Invalid amount: ${amount}`)
  return units
}

export function baseUnitsToDecimalString(units: bigint, decimals: unknown): string {
  const precision = normalizeDecimals(decimals)
  if (precision === null || precision <= 0) return units.toString()
  const scale = 10n ** BigInt(precision)
  const whole = units / scale
  const fraction = units % scale
  if (fraction === 0n) return whole.toString()
  const frac = fraction.toString().padStart(precision, '0').replace(/0+$/, '')
  return `${whole.toString()}.${frac}`
}

export function tokenMaxPrecisionReserveUnits(decimals: unknown): bigint {
  const precision = normalizeDecimals(decimals)
  if (precision === null) return 1n
  if (precision === 0) return 0n
  return 10n ** BigInt(Math.max(0, precision - TOKEN_MAX_DISPLAY_DECIMALS))
}

export function tokenMaxSpendableBaseUnits(balance: string, decimals: unknown): bigint | null {
  const balanceUnits = decimalToBaseUnits(balance, decimals)
  if (balanceUnits === null) return null
  const reserveUnits = tokenMaxPrecisionReserveUnits(decimals)
  return balanceUnits > reserveUnits ? balanceUnits - reserveUnits : 0n
}

export function tokenMaxSpendableAmount(balance: string, decimals: unknown): string {
  const spendableUnits = tokenMaxSpendableBaseUnits(balance, decimals)
  if (spendableUnits === null) return balance
  return baseUnitsToDecimalString(spendableUnits, decimals)
}

export function nativeMaxSpendableAmount(balance: string, decimals: unknown, reserve: string | number): string {
  const balanceUnits = decimalToBaseUnits(balance, decimals)
  const reserveUnits = decimalToBaseUnits(String(reserve), decimals)
  if (balanceUnits === null || reserveUnits === null) return balance

  const spendableUnits = balanceUnits - reserveUnits
  if (spendableUnits <= 0n) return '0'
  return baseUnitsToDecimalString(spendableUnits, decimals)
}
