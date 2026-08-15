/**
 * What a chain row is allowed to claim about its balance.
 *
 * There are THREE states, not two. Modelling only "loading" vs "loaded" is what
 * lets the dashboard assert "0 ETH" for a chain nobody successfully queried:
 * `getBalances` resolves on a PARTIAL portfolio response (see index.ts —
 * "failed chains will show 0"), so `loadingBalances` is already false by the
 * time those rows render, and the missing entry reads as an empty wallet.
 *
 * Same bug class as the signing-side one fixed in #411: a failed lookup is not
 * a zero. Here it is cosmetic rather than financial, but it is the number a
 * user decides to top up or move funds against.
 */
import { normalizeAssetCaip } from './balance-reconciliation'

export type BalanceDisplayState = 'pending' | 'unknown' | 'known'

export interface BalanceDisplayInput {
  /** Is there an entry for this chain in the balances map at all? */
  hasEntry: boolean
  /** Per-chain trust marker set by getBalances (index.ts). Absent on cached
   *  and legacy rows, which are real numbers — only 'degraded' means the
   *  backend told us it could not answer for this chain. */
  syncState?: 'confirmed' | 'stale' | 'degraded'
  loadingBalances: boolean
  initialLoaded: boolean
}

export function balanceDisplayState(input: BalanceDisplayInput): BalanceDisplayState {
  if (!input.hasEntry) {
    // No answer yet. Distinguish "one is still coming" from "the fetch settled
    // and this chain simply never arrived".
    return input.loadingBalances || !input.initialLoaded ? 'pending' : 'unknown'
  }
  // 'stale' is a real number that is merely old — the UI surfaces staleness
  // separately. Only 'degraded' means the value cannot be trusted as a figure.
  return input.syncState === 'degraded' ? 'unknown' : 'known'
}

/**
 * Same rule as the 'degraded' branch above, for the screens that hold one
 * chain's balance and have no notion of a global load state — the send form
 * and the swap dialog, which otherwise read a placeholder zero as "this
 * account is empty" and say so.
 */
export function isBalanceUnverified(
  balance?: { syncState?: BalanceDisplayInput['syncState']; confirmedAssetCaips?: string[] },
  assetCaip?: string,
): boolean {
  // A missing entry is not a verified zero. balanceDisplayState never returns
  // 'known' without one, and these screens have no load state to tell "still
  // coming" from "never arrived" — either way we do not have a number. The
  // always-visible chain list (#410) makes this reachable: Send opens for a
  // chain that has no entry yet, and `balance?.balance || '0'` printed a
  // confident zero for it.
  if (!balance) return true
  if (balance.syncState !== 'degraded') return false
  // A degraded chain can still carry an asset proven directly over RPC —
  // mergeTrustedBalanceSnapshot merges exactly those tokens through. That
  // asset's figure is real even when its chain's aggregate is not.
  if (!assetCaip) return true
  const wanted = normalizeAssetCaip(assetCaip)
  return !balance.confirmedAssetCaips?.some(caip => normalizeAssetCaip(caip) === wanted)
}
