import { evmChainLabel } from './chains'

const parse = (value: unknown): bigint | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const raw = String(value)
  if (!/^(?:0x[0-9a-fA-F]+|\d+)$/.test(raw)) return null
  try { return BigInt(raw) } catch { return null }
}
const unit = (chainId?: number): string => evmChainLabel(chainId)?.symbol ?? 'native coin'
const formatWei = (wei: bigint, chainId?: number): string => {
  const whole = wei / 10n ** 18n
  const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')
  return `${fraction ? `${whole}.${fraction}` : whole.toString()} ${unit(chainId)}`
}

/** Native value in the exact EVM signing request, displayed in human units. */
export function evmNativeValue(value: unknown, chainId?: number): string | null {
  const wei = parse(value)
  return wei === null ? null : formatWei(wei, chainId)
}

/** Maximum fee from the exact EVM signing request; never use a quote or
 * estimated gas here. EIP-1559 uses maxFeePerGas, not priority fee. */
export function evmMaxFee(body: Record<string, unknown> | undefined, chainId?: number): string | null {
  if (!body) return null
  const limit = parse(body.gasLimit ?? body.gas)
  const price = parse(body.maxFeePerGas ?? body.max_fee_per_gas ?? body.gasPrice ?? body.gas_price)
  if (limit === null || price === null) return null
  return formatWei(limit * price, chainId)
}
