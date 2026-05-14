export const SOLANA_LAMPORTS_PER_SIGNATURE = 5000n
const SOLANA_DECIMALS = 9

function decimalAmountToBaseUnits(amount: string, decimals: number): bigint {
  const normalized = String(amount || '').trim()
  if (!/^\d*(?:\.\d*)?$/.test(normalized) || normalized === '' || normalized === '.') {
    throw new Error(`Invalid amount: ${amount}`)
  }
  const parts = normalized.split('.')
  const whole = parts[0] || '0'
  const frac = (parts[1] || '').slice(0, decimals).padEnd(decimals, '0')
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac)
}

export function solanaTransferLamportsForAmount(amount: string, isMax = false): bigint {
  const lamports = decimalAmountToBaseUnits(amount, SOLANA_DECIMALS)
  if (!isMax) return lamports
  if (lamports <= SOLANA_LAMPORTS_PER_SIGNATURE) {
    throw new Error('Insufficient SOL for max swap: balance does not cover the Solana network fee')
  }
  return lamports - SOLANA_LAMPORTS_PER_SIGNATURE
}
