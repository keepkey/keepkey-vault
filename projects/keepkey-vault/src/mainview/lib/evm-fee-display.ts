import { evmChainLabel } from '../../shared/chains'

/** Above this a value cannot be the gas used by one transaction (block gas
 *  limits are tens of millions), so it is already a fee in wei. */
const MAX_PLAUSIBLE_GAS = 1_000_000_000

/**
 * Display text for the network fee an EVM swap input actually paid.
 *
 * Pioneer's `blockchainTxData.gasUsed` is usually gas units, but on some L2
 * paths (e.g. Base, with its L1 data fee) it carries the total fee in wei and
 * no `effectiveGasPrice`. That rendered as "1,889,359,425,858 gas" instead of
 * ~0.0000019 ETH. Display only; nothing here feeds a transaction.
 *
 *   gas + price known     -> "0.0000019 ETH · 37,773 gas · 0.05 gwei"
 *   value is a wei fee    -> "0.0000019 ETH"
 *   gas only              -> "37,773 gas"
 */
export function formatEvmFeePaid(
  gasUsed: string,
  effectiveGasPrice: string | undefined,
  fromCaip: string | undefined,
  locale: string,
): string {
  const used = Number(gasUsed)
  if (!Number.isFinite(used) || used < 0) return `${gasUsed} gas`
  const chainId = fromCaip?.startsWith('eip155:') ? fromCaip.split('/')[0]!.slice('eip155:'.length) : undefined
  const symbol = evmChainLabel(chainId)?.symbol ?? 'ETH'
  const native = (wei: number) => `${new Intl.NumberFormat(locale, { maximumSignificantDigits: 2 }).format(wei / 1e18)} ${symbol}`
  const gwei = effectiveGasPrice !== undefined ? Number(effectiveGasPrice) / 1e9 : NaN
  if (Number.isFinite(gwei) && gwei > 0 && used <= MAX_PLAUSIBLE_GAS) {
    return `${native(used * gwei * 1e9)} · ${used.toLocaleString(locale)} gas · ${gwei.toFixed(2)} gwei`
  }
  if (used > MAX_PLAUSIBLE_GAS) return native(used)
  return `${used.toLocaleString(locale)} gas`
}
