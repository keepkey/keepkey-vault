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

/** Confidence for a single-chain portfolio response, including partial HTTP 200s. */
export function portfolioBalanceSyncState(meta?: {
  degraded?: boolean
  failures?: readonly unknown[]
  staleChains?: readonly unknown[]
} | null): 'confirmed' | 'stale' | 'degraded' {
  if (meta?.degraded || meta?.failures?.length) return 'degraded'
  if (meta?.staleChains?.length) return 'stale'
  return 'confirmed'
}

/** Chains a portfolio response itself reports failed or stale. Their rows are
 *  not confirmed for the cache, so they never clear a pending tx mark (H3). */
export function portfolioFaultChainIds(
  meta: { failures?: readonly { caip: string }[]; staleChains?: readonly { caip: string }[] } | null | undefined,
  chainIdForCaip: (caip: string) => string | undefined,
): Set<string> {
  const ids = [...(meta?.failures || []), ...(meta?.staleChains || [])].map(f => chainIdForCaip(f.caip))
  return new Set(ids.filter((id): id is string => !!id))
}

/** A chain total cannot attest to one account's missing token. Require a
 * matching native owner row and a complete, fresh response for that owner. */
export function ownerPortfolioConfidence(entries: any[], owner: string, nativeCaip: string, meta?: Parameters<typeof portfolioBalanceSyncState>[0], now = Date.now()) {
  const network = nativeCaip.split('/')[0].toLowerCase()
  const rows = entries.filter(entry => String(entry?.caip || '').split('/')[0].toLowerCase() === network
    && String(entry?.pubkey || entry?.address || '').toLowerCase() === owner.toLowerCase())
  const native = rows.find(entry => String(entry.caip).toLowerCase() === nativeCaip.toLowerCase())
  const valid = (entry: any) => entry?.balance != null && String(entry.balance).trim() !== ''
    && Number.isFinite(Number(entry.balance)) && Number(entry.balance) >= 0
  let syncState = portfolioBalanceSyncState(meta)
  if (!native || !valid(native) || rows.some(entry => entry.degraded === true || entry.verified === false || !valid(entry))) syncState = 'degraded'
  else if (syncState !== 'degraded' && rows.some(entry => entry.isStale === true || entry.syncState === 'stale')) syncState = 'stale'
  return { syncState, updatedAt: now,
    confirmedAssetCaips: syncState === 'confirmed' ? [...new Set(rows.map(entry => String(entry.caip)))] : [] }
}

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
 * The one balance entry a screen must BOTH judge and read from.
 *
 * SwapDialog judged its cached `balances` array but let the amount fall through
 * to the `balance` prop, so a degraded prop cleared a check that never examined
 * it — and with any non-empty cache missing the selected chain (which also
 * makes the dialog skip its live fetch) that placeholder zero drove
 * Available/USD/MAX. Confidence and figure have to resolve to the same object,
 * so both go through this.
 */
export function selectBalanceEntry<T extends { chainId?: string }>(
  cached: readonly T[],
  fallback: T | undefined,
  chainId: string,
): T | undefined {
  return cached.find(entry => entry.chainId === chainId)
    ?? (fallback?.chainId === chainId ? fallback : undefined)
}

/**
 * Same rule as the 'degraded' branch above, for the screens that hold one
 * chain's balance and have no notion of a global load state — the send form
 * and the swap dialog, which otherwise read a placeholder zero as "this
 * account is empty" and say so.
 *
 * Callers needing both an asset verdict and a native-gas verdict must call this
 * twice with different caips. One shared boolean let a directly-confirmed SPL
 * token vouch for a SOL balance nobody had fetched.
 */
/** Why a balance is not a usable figure: no entry yet ('missing'), or the backend
 *  said it could not answer for the chain ('degraded'). Undefined = verified.
 *  Screens pick their message from this; "could not reach" is only true for 'degraded'. */
export function balanceUnverifiedReason(
  balance?: { syncState?: BalanceDisplayInput['syncState']; confirmedAssetCaips?: string[] },
  assetCaip?: string,
): 'missing' | 'degraded' | undefined {
  if (!balance) return 'missing'
  return isBalanceUnverified(balance, assetCaip) ? 'degraded' : undefined
}

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
