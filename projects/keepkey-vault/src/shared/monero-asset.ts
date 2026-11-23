/** What the Monero asset row and page show, as pure decisions (the components only translate them).
 *  The rule throughout: a balance that is not known is "—", never 0. */
import type { MoneroStatus } from './types'
import { supportsMoneroSigning } from './monero-capability'
import { moneroAddressKind, parseXmrAmount } from './monero-address'

const ATOMIC_UNITS = 1_000_000_000_000n

/** Connected capability firmware or the legacy emulator; the backend separately authenticates research signing builds. */
export function moneroChainVisible(input: { settingEnabled: boolean; capabilities?: readonly number[]; isEmulator?: boolean; watchOnly?: boolean; bitcoinOnly?: boolean }): boolean {
  return input.settingEnabled && (supportsMoneroSigning(input.capabilities) || input.isEmulator === true) && !input.watchOnly && !input.bitcoinOnly
}

/** All twelve decimals, never through Number. */
export function formatXmr(atomic: string | bigint): string {
  const value = BigInt(atomic)
  return `${value / ATOMIC_UNITS}.${(value % ATOMIC_UNITS).toString().padStart(12, '0')}`
}

/** Trailing zeros dropped (at least one decimal), for rows and headers. */
export function formatXmrShort(atomic: string | bigint): string {
  return formatXmr(atomic).replace(/0+$/, '').replace(/\.$/, '.0')
}

export type MoneroBalanceState = 'loading' | 'not-connected' | 'scanning' | 'ready' | 'unreachable'

export interface MoneroBalanceView {
  state: MoneroBalanceState
  /** Atomic strings; null renders as "—". */
  balanceAtomic: string | null
  unlockedAtomic: string | null
  lockedAtomic: string | null
  /** 0..<1 while scanning toward a valid tip; caught-up-but-not-ready remains indeterminate. */
  progress?: number
  walletHeight?: number
  daemonHeight?: number
  restoreHeight?: number
  /** When the shown balance was last refreshed (the "last known" time when the node is down). */
  updatedAt?: string
  /** False until key images prove which received outputs are unspent. */
  spendVerified: boolean
  /** A balance is shown but its last refresh is older than STALE_AFTER_MS (or unknown): say when it is from. */
  stale: boolean
  /** Persisted display snapshot; never proof of current spendability or signing readiness. */
  lastKnown?: boolean
}

/** The watch wallet refreshes every 15 s; older than this, a figure is labelled with its time. */
export const STALE_AFTER_MS = 120_000

/** Wallet scanning covers the selected history range, not all blocks since genesis.
 * A zero/unreported height, invalid range, or a caught-up wallet still waiting
 * for its ready status cannot support a remaining-work percentage. */
export function moneroWalletScanProgress({ walletHeight, daemonHeight, restoreHeight = 0 }: {
  walletHeight?: number; daemonHeight?: number; restoreHeight?: number
}): number | undefined {
  if (typeof walletHeight !== 'number' || !Number.isSafeInteger(walletHeight) || walletHeight <= 0 ||
      typeof daemonHeight !== 'number' || !Number.isSafeInteger(daemonHeight) || daemonHeight <= 0 ||
      !Number.isSafeInteger(restoreHeight) || restoreHeight < 0 || daemonHeight <= restoreHeight || walletHeight >= daemonHeight) return undefined
  return Math.max(0, (walletHeight - restoreHeight) / (daemonHeight - restoreHeight))
}

/**
 * - startup / scanning: the wallet-scoped saved balance when available, otherwise "—";
 * - partial live scans never overwrite a saved figure;
 * - node or monitor down: the last known balance (or "—" if there never was one), labelled with its time;
 * - ready: the balance, with spendVerified false until key images are synced.
 */
export function moneroBalanceView(status: MoneroStatus | null, refreshError?: string | null, now = Date.now()): MoneroBalanceView {
  const unknown = (state: MoneroBalanceState): MoneroBalanceView => ({ state, balanceAtomic: null, unlockedAtomic: null, lockedAtomic: null, spendVerified: false, stale: false })
  if (!status) return unknown(refreshError ? 'unreachable' : 'loading')
  const heights = { walletHeight: status.walletHeight, daemonHeight: status.daemonHeight, restoreHeight: status.restoreHeight }
  const scanned = status.available && status.walletHeight > 0
  const state: MoneroBalanceState = refreshError ? 'unreachable' : !status.available ? status.syncState === 'unreachable' ? 'unreachable' : 'not-connected'
    : status.syncState === 'not-connected' ? 'scanning' : status.syncState
  const caughtUp = scanned && status.daemonHeight !== undefined && status.walletHeight >= status.daemonHeight
  const showBalance = scanned && (state === 'ready' || state === 'unreachable' || caughtUp)
  const progress = state === 'scanning' ? moneroWalletScanProgress(heights) : undefined
  // A saved observation is shown during startup, incomplete scans and failures.
  // Only a fresh, authoritative ready result may replace it (including zero).
  const cached = status.cachedBalance
  const useCached = cached && !(state === 'ready' && showBalance && (status.spendStateKnown || status.balanceAtomic === '0'))
  // Fresh but not spend-verified: the saved balance plus payments received after it was saved.
  // The watch total can't see spends without key images, so it only caps the sum, never replaces it.
  if (useCached && state === 'ready' && showBalance) {
    const seen = new Set<string>()
    let incoming = 0n, incomingUnlocked = 0n
    for (const tx of status.transactions) {
      if (seen.has(tx.txid) || !(tx.type === 'pool' || (tx.type === 'in' && (tx.height ?? 0) >= cached.walletHeight))) continue
      seen.add(tx.txid); incoming += BigInt(tx.amountAtomic); if (!tx.locked && tx.type === 'in') incomingUnlocked += BigInt(tx.amountAtomic)
    }
    const min = (a: bigint, b: bigint) => a < b ? a : b
    const balance = min(BigInt(cached.balanceAtomic) + incoming, BigInt(status.balanceAtomic))
    const unlocked = min(BigInt(cached.unlockedBalanceAtomic) + incomingUnlocked, min(balance, BigInt(status.unlockedBalanceAtomic)))
    return {
      state, ...heights, ...(status.updatedAt ? { updatedAt: status.updatedAt } : {}),
      balanceAtomic: balance.toString(), unlockedAtomic: unlocked.toString(), lockedAtomic: (balance - unlocked).toString(),
      spendVerified: true, stale: false,
    }
  }
  if (useCached) return {
    state, ...heights, ...(progress === undefined ? {} : { progress }), updatedAt: cached.updatedAt,
    balanceAtomic: cached.balanceAtomic, unlockedAtomic: null, lockedAtomic: null,
    spendVerified: false, stale: true, lastKnown: true,
  }
  const balance = BigInt(status.balanceAtomic), unlocked = BigInt(status.unlockedBalanceAtomic)
  return {
    state, ...heights, ...(progress === undefined ? {} : { progress }), ...(status.updatedAt ? { updatedAt: status.updatedAt } : {}),
    balanceAtomic: showBalance ? balance.toString() : null,
    unlockedAtomic: showBalance ? unlocked.toString() : null,
    lockedAtomic: showBalance ? (balance - unlocked).toString() : null,
    spendVerified: showBalance && status.spendStateKnown === true,
    stale: showBalance && !(status.updatedAt && now - Date.parse(status.updatedAt) <= STALE_AFTER_MS),
  }
}

export type MoneroSendProblem = 'integrated' | 'invalid-address' | 'own-address' | 'invalid-amount' | 'more-than-unlocked'

/** Problems shown under the form before anything reaches the wallet (the backend checks again). */
export function moneroSendInputProblems(input: { address: string; amount: string; max: boolean; walletAddress: string; unlockedAtomic: string | null }):
  { address?: MoneroSendProblem; amount?: MoneroSendProblem; amountAtomic: string | null } {
  const address = input.address.trim(), kind = address ? moneroAddressKind(address) : null
  const addressProblem: MoneroSendProblem | undefined = !address ? undefined
    : kind === 'integrated' ? 'integrated' : !kind ? 'invalid-address' : address === input.walletAddress ? 'own-address' : undefined
  if (input.max) return { ...(addressProblem ? { address: addressProblem } : {}), amountAtomic: null }
  const amountAtomic = input.amount.trim() ? parseXmrAmount(input.amount) : null
  const amountProblem: MoneroSendProblem | undefined = !input.amount.trim() ? undefined : !amountAtomic ? 'invalid-amount'
    : input.unlockedAtomic !== null && BigInt(amountAtomic) > BigInt(input.unlockedAtomic) ? 'more-than-unlocked' : undefined
  return { ...(addressProblem ? { address: addressProblem } : {}), ...(amountProblem ? { amount: amountProblem } : {}), amountAtomic }
}
