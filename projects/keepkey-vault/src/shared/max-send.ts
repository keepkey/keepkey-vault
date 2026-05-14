export const TOKEN_MAX_DISPLAY_DECIMALS = 8

export function decimalToBaseUnits(amount: string, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0) return null
  const normalized = String(amount || '').trim()
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return null

  const [whole = '0', fraction = ''] = normalized.split('.')
  const scale = 10n ** BigInt(decimals)
  const fractionalUnits = (fraction || '').slice(0, decimals).padEnd(decimals, '0')
  return BigInt(whole) * scale + BigInt(fractionalUnits || '0')
}

export function decimalToBaseUnitsStrict(amount: string, decimals: number): bigint {
  const units = decimalToBaseUnits(amount, decimals)
  if (units === null) throw new Error(`Invalid amount: ${amount}`)
  return units
}

export function baseUnitsToDecimalString(units: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals <= 0) return units.toString()
  const scale = 10n ** BigInt(decimals)
  const whole = units / scale
  const fraction = units % scale
  if (fraction === 0n) return whole.toString()
  const frac = fraction.toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${whole.toString()}.${frac}`
}

export function tokenMaxPrecisionReserveUnits(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) return 1n
  if (decimals === 0) return 0n
  return 10n ** BigInt(Math.max(0, decimals - TOKEN_MAX_DISPLAY_DECIMALS))
}

export function tokenMaxSpendableBaseUnits(balance: string, decimals: number): bigint | null {
  const balanceUnits = decimalToBaseUnits(balance, decimals)
  if (balanceUnits === null) return null
  const reserveUnits = tokenMaxPrecisionReserveUnits(decimals)
  return balanceUnits > reserveUnits ? balanceUnits - reserveUnits : 0n
}

export function tokenMaxSpendableAmount(balance: string, decimals: number): string {
  const spendableUnits = tokenMaxSpendableBaseUnits(balance, decimals)
  if (spendableUnits === null) return balance
  return baseUnitsToDecimalString(spendableUnits, decimals)
}

export function nativeMaxSpendableAmount(balance: string, decimals: number, reserve: string | number): string {
  const balanceUnits = decimalToBaseUnits(balance, decimals)
  const reserveUnits = decimalToBaseUnits(String(reserve), decimals)
  if (balanceUnits === null || reserveUnits === null) return balance

  const spendableUnits = balanceUnits - reserveUnits
  if (spendableUnits <= 0n) return '0'
  return baseUnitsToDecimalString(spendableUnits, decimals)
}
