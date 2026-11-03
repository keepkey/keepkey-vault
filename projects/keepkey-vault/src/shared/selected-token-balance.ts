import type { ChainBalance, TokenBalance } from './types'
import { isBalanceUnverified } from './balance-display-state'
import { normalizeAssetCaip } from './balance-reconciliation'

export interface SelectedTokenState {
  token: TokenBalance
  chainId: string
  ownerAddress?: string
}

function ownerKey(address: string, caip: string): string {
  return caip.startsWith('eip155:') ? address.toLowerCase() : address
}

/** Keep asset identity while replacing amounts only from the selected owner. */
export function reconcileSelectedToken(
  selected: SelectedTokenState | null,
  context: { chainId: string; chainCaip: string; ownerAddress?: string | null },
  balance?: ChainBalance,
): { selection: SelectedTokenState | null; unverified: boolean } {
  if (!selected) return { selection: null, unverified: false }
  const token = selected.token
  if (selected.chainId !== context.chainId || token.caip.split('/')[0] !== context.chainCaip.split('/')[0]) {
    return { selection: null, unverified: false }
  }
  const owner = context.ownerAddress || undefined
  const matchesOwner = (candidate?: string) => !!owner && !!candidate
    && ownerKey(candidate, token.caip) === ownerKey(owner, token.caip)
  if (owner && selected.ownerAddress && !matchesOwner(selected.ownerAddress)) {
    return { selection: null, unverified: false }
  }
  if (!balance || balance.chainId !== context.chainId || !matchesOwner(balance.address)) {
    return { selection: selected, unverified: true }
  }
  const wanted = normalizeAssetCaip(token.caip)
  const directlyConfirmed = !!balance.confirmedAssetCaips?.some(caip => normalizeAssetCaip(caip) === wanted)
  const trusted = directlyConfirmed || (balance.syncState !== 'stale' && !isBalanceUnverified(balance, token.caip))
  if (!trusted) return { selection: selected, unverified: true }
  const live = balance.tokens?.find(candidate => normalizeAssetCaip(candidate.caip) === wanted)
  // An unmarked legacy/cache row can supply an explicit amount, but absence
  // proves zero only after a fresh authoritative owner-scoped response.
  if (!live && balance.syncState !== 'confirmed' && !directlyConfirmed) {
    return { selection: selected, unverified: true }
  }
  const nextToken: TokenBalance = {
    ...token,
    balance: live?.balance ?? '0',
    balanceUsd: live?.balanceUsd ?? 0,
    priceUsd: live?.priceUsd ?? token.priceUsd,
    pendingBalance: live?.pendingBalance,
    dataSource: live?.dataSource ?? token.dataSource,
  }
  const unchanged = matchesOwner(selected.ownerAddress)
    && nextToken.balance === token.balance && nextToken.balanceUsd === token.balanceUsd
    && nextToken.priceUsd === token.priceUsd && nextToken.pendingBalance === token.pendingBalance
    && nextToken.dataSource === token.dataSource
  return {
    selection: unchanged ? selected : { ...selected, ownerAddress: owner, token: nextToken },
    unverified: false,
  }
}
