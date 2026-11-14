import type { ChainBalance, EvmAddressChainBalance } from '../../shared/types'

/** The selected EVM owner's balance for the center card. Its native coin is
 *  priced with the sidebar's (aggregate) price: the price refresh only rewrites
 *  the aggregate (audit v4 H14/H18). A sole owner's figure the sidebar refused
 *  (stale or degraded) falls back to the aggregate, so the card and the sidebar
 *  never show different amounts for the same account (audit v4 H3). */
export function selectedOwnerBalance(
  agg: ChainBalance | undefined,
  cb: EvmAddressChainBalance | undefined,
  address: string,
  soleOwner: boolean,
): ChainBalance | undefined {
  if (!cb || (agg && soleOwner && (cb.syncState === 'stale' || cb.syncState === 'degraded'))) return agg
  const aggBal = parseFloat(agg?.balance || '0')
  const price = aggBal > 0 && agg?.nativeBalanceUsd != null ? agg.nativeBalanceUsd / aggBal : undefined
  const nativeBalanceUsd = price !== undefined ? parseFloat(cb.balance || '0') * price : cb.nativeBalanceUsd
  const balanceUsd = price !== undefined ? (cb.balanceUsd || 0) - (cb.nativeBalanceUsd || 0) + (nativeBalanceUsd || 0) : cb.balanceUsd
  return {
    chainId: cb.chainId,
    symbol: agg?.symbol || cb.symbol,
    balance: cb.balance,
    balanceUsd,
    nativeBalanceUsd,
    address,
    tokens: cb.tokens,
    defiPositions: cb.defiPositions,
    updatedAt: agg?.updatedAt,
  }
}
