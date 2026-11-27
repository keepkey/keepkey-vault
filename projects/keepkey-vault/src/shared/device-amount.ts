import { decimalToBaseUnits } from './max-send'

/** bn_format(..., trailing=false): every decimal the amount has, no trailing zeros. */
function bnFormat(units: bigint, decimals: number): string {
  if (decimals <= 0) return units.toString()
  const scale = 10n ** BigInt(decimals)
  const frac = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return frac ? `${units / scale}.${frac}` : `${units / scale}`
}

/** coin_amnt_to_str() (coins.c @ 378cf30): 8 decimals, least significant zeros
 *  dropped, and a bare ".0" for a whole amount ("1.0 BTC"). */
function coinAmountToStr(sats: bigint): string {
  const whole = sats / 100_000_000n, fraction = sats % 100_000_000n
  return fraction > 0n ? `${whole}.${fraction.toString().padStart(8, '0').replace(/0+$/, '')}` : `${whole}.0`
}

export interface DeviceAmountInput {
  chainFamily: string
  /** Decimals of what is sent: the chain's, or the token's. */
  decimals: number
  isToken: boolean
  symbol: string
}

/**
 * The amount as the KeepKey (firmware 378cf30) prints it on its confirm screen,
 * so the review can be compared with the OLED character by character.
 * - UTXO: coin_amnt_to_str.
 * - EVM: ethereumFormatAmount; native below 1 gwei is shown in Wei, else the full
 *   18 decimals without trailing zeros; tokens use their decimals.
 * - Others: the exact amount, no rounding, no trailing zeros.
 * Returns null when the amount does not parse (the caller shows it as given).
 */
export function deviceAmountText(amount: string, input: DeviceAmountInput): string | null {
  const units = decimalToBaseUnits(amount, input.decimals)
  if (units === null) return null
  if (input.chainFamily === 'utxo' && input.decimals === 8) return `${coinAmountToStr(units)} ${input.symbol}`
  if (input.chainFamily === 'evm' && !input.isToken && input.decimals === 18 && units < 1_000_000_000n) return `${units} Wei`
  return `${bnFormat(units, input.decimals)} ${input.symbol}`
}
