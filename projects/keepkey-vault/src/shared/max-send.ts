export const TOKEN_MAX_DISPLAY_DECIMALS = 8

/**
 * L2s that also charge an L1 data-posting fee on top of gasPrice × gasLimit.
 * A native max send keeps this much back so it is not rejected for the L1 fee.
 */
export const L1_DATA_FEE_CHAIN_IDS: readonly string[] = ['base', 'optimism', 'arbitrum']
export const L1_DATA_FEE_BUFFER_WEI = 50_000_000_000_000n // 0.00005 ETH

export function l1DataFeeBufferWei(chainId: string): bigint {
  return L1_DATA_FEE_CHAIN_IDS.includes(chainId) ? L1_DATA_FEE_BUFFER_WEI : 0n
}
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
  // A balance with at most 8 decimals is shown exactly: nothing to reserve.
  // Above that, keep back the one displayed 8-decimal quantum the rounding may hide.
  if (precision <= TOKEN_MAX_DISPLAY_DECIMALS) return 0n
  return 10n ** BigInt(precision - TOKEN_MAX_DISPLAY_DECIMALS)
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

/** TON fee reserve: ~0.005 TON for a transfer, ~0.01 TON when the wallet deploys in the same message. */
export const TON_TRANSFER_FEE_RESERVE_NANO = 5_000_000n
export const TON_DEPLOY_FEE_RESERVE_NANO = 10_000_000n

/**
 * TON max: the on-chain balance (nanoTON) minus the fee reserve. Never send_mode 128
 * (carry all remaining balance), so the amount the device confirms is the amount sent.
 * Returns null when the balance does not cover the reserve.
 */
export function tonMaxSpendableNano(balanceNano: string, needsDeploy: boolean): bigint | null {
  if (!/^\d+$/.test(String(balanceNano ?? '').trim())) return null
  const reserve = needsDeploy ? TON_DEPLOY_FEE_RESERVE_NANO : TON_TRANSFER_FEE_RESERVE_NANO
  const spendable = BigInt(String(balanceNano).trim()) - reserve
  return spendable > 0n ? spendable : null
}
