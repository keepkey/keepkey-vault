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
/** The selected token's balanceOf, read on chain for one owner (ERC-20 via our
 *  own nodes). It vouches for that one asset while the chain's portfolio can't,
 *  e.g. when the token-discovery provider is down. */
export interface DirectTokenProof {
  chainId: string
  owner: string
  caip: string
  balance: string
  verifiedAt: number
}

/** ponytail: a proof is trusted for a minute; the page re-reads it after that and after any balance update. */
export const DIRECT_TOKEN_PROOF_MAX_AGE_MS = 60_000

export function reconcileSelectedToken(
  selected: SelectedTokenState | null,
  context: { chainId: string; chainCaip: string; ownerAddress?: string | null },
  balance?: ChainBalance,
  proof?: DirectTokenProof | null,
  now = Date.now(),
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
  // Used only where the portfolio cannot vouch for this token.
  const proven = (): { selection: SelectedTokenState; unverified: false } | null => {
    if (!proof || proof.chainId !== context.chainId || !matchesOwner(proof.owner)) return null
    if (normalizeAssetCaip(proof.caip) !== normalizeAssetCaip(token.caip)) return null
    if (proof.verifiedAt > now || now - proof.verifiedAt > DIRECT_TOKEN_PROOF_MAX_AGE_MS) return null
    const amount = Number(proof.balance)
    const price = token.priceUsd ?? 0
    const balanceUsd = price > 0 && Number.isFinite(amount) ? amount * price : 0
    if (matchesOwner(selected.ownerAddress) && token.balance === proof.balance && token.balanceUsd === balanceUsd) {
      return { selection: selected, unverified: false }
    }
    return { selection: { ...selected, ownerAddress: owner, token: { ...token, balance: proof.balance, balanceUsd } }, unverified: false }
  }
  if (!balance || balance.chainId !== context.chainId || !matchesOwner(balance.address)) {
    return proven() ?? { selection: selected, unverified: true }
  }
  const wanted = normalizeAssetCaip(token.caip)
  const directlyConfirmed = !!balance.confirmedAssetCaips?.some(caip => normalizeAssetCaip(caip) === wanted)
  const trusted = directlyConfirmed || (balance.syncState !== 'stale' && !isBalanceUnverified(balance, token.caip))
  if (!trusted) return proven() ?? { selection: selected, unverified: true }
  const live = balance.tokens?.find(candidate => normalizeAssetCaip(candidate.caip) === wanted)
  // An unmarked legacy/cache row can supply an explicit amount, but absence
  // proves zero only after a fresh authoritative owner-scoped response.
  if (!live && balance.syncState !== 'confirmed' && !directlyConfirmed) {
    return proven() ?? { selection: selected, unverified: true }
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
