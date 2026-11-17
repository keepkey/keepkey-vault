import { CHAINS, type ChainDef } from './chains'
import { baseUnitsToDecimalString, normalizeDecimals } from './max-send'
import type { SwapAsset } from './types'

type AmountAsset = Pick<SwapAsset, 'chainId' | 'caip' | 'decimals'>

/** A recognized native CAIP gets its precision from the chain, never a provider's
 * generic default. Token precision remains independent of its gas asset. */
export function nativeSwapAssetDecimals(asset: Pick<AmountAsset, 'chainId' | 'caip'>, chains: readonly ChainDef[] = CHAINS): number | null {
  const chain = chains.find(row => row.id === asset.chainId)
  if (!chain || !asset.caip) return null
  const matches = chain.chainFamily === 'evm'
    ? asset.caip.toLowerCase() === chain.caip.toLowerCase() : asset.caip === chain.caip
  return matches ? normalizeDecimals(chain.decimals) : null
}

export function swapAssetDecimals(asset: AmountAsset, chains: readonly ChainDef[] = CHAINS): number | null {
  return nativeSwapAssetDecimals(asset, chains) ?? normalizeDecimals(asset.decimals)
}

/** Floor a computed balance/MAX amount to atomic units without a floating-point
 * round trip. Scientific notation is accepted only for these computed values. */
export function quantizeComputedSwapAmount(value: string, decimals: unknown): string | null {
  const precision = normalizeDecimals(decimals)
  if (precision === null || value.length > 512) return null
  const match = value.match(/^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i)
  if (!match) return null
  const exponent = Number(match[3] ?? 0)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 512) return null
  const fraction = match[2] ?? ''
  const coefficient = BigInt(match[1] + fraction)
  const shift = precision + exponent - fraction.length
  const units = shift >= 0 ? coefficient * 10n ** BigInt(shift) : coefficient / 10n ** BigInt(-shift)
  return baseUnitsToDecimalString(units, precision)
}

export function swapAmountExceedsPrecision(value: string, decimals: unknown): boolean {
  const precision = normalizeDecimals(decimals)
  return precision !== null && /[1-9]/.test((value.split('.')[1] ?? '').slice(precision))
}

/** Explicit input may shed only redundant zeros, never a nonzero atomic amount. */
export function canonicalSwapAmount(value: string, decimals: unknown): string | null {
  if (!/^\d+(?:\.\d*)?$/.test(value) || swapAmountExceedsPrecision(value, decimals)) return null
  return quantizeComputedSwapAmount(value, decimals)
}
