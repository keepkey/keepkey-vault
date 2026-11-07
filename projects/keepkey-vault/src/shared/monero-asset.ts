/** What the Monero asset row and page show, as pure decisions (the components only translate them).
 *  The rule throughout: a balance that is not known is "—", never 0. */
import type { MoneroStatus } from './types'
import { firmwareSupportsMonero } from './firmware-versions'
import { moneroAddressKind, parseXmrAmount } from './monero-address'

const ATOMIC_UNITS = 1_000_000_000_000n

/** The XMR row is shown with the Monero setting on and firmware 7.17+, on a connected (not saved) multi-coin wallet. */
export function moneroChainVisible(input: { settingEnabled: boolean; firmwareVersion?: string; watchOnly?: boolean; bitcoinOnly?: boolean }): boolean {
  return input.settingEnabled && firmwareSupportsMonero(input.firmwareVersion) && !input.watchOnly && !input.bitcoinOnly
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
  /** 0..1 while scanning, when the wallet has scanned some blocks toward a known tip. */
  progress?: number
  walletHeight?: number
  daemonHeight?: number
  restoreHeight?: number
  /** When the shown balance was last refreshed (the "last known" time when the node is down). */
  updatedAt?: string
  /** False until key images prove which received outputs are unspent. */
  spendVerified: boolean
}

/**
 * - not connected / loading: "—";
 * - scanning toward the tip: "—" plus progress (a part-scanned balance is not the balance);
 * - node or monitor down: the last known balance (or "—" if there never was one), labelled with its time;
 * - ready: the balance, with spendVerified false until key images are synced.
 */
export function moneroBalanceView(status: MoneroStatus | null, refreshError?: string | null): MoneroBalanceView {
  const unknown = (state: MoneroBalanceState): MoneroBalanceView => ({ state, balanceAtomic: null, unlockedAtomic: null, lockedAtomic: null, spendVerified: false })
  if (!status) return unknown(refreshError ? 'unreachable' : 'loading')
  if (!status.available) return unknown('not-connected')
  const heights = { walletHeight: status.walletHeight, daemonHeight: status.daemonHeight, restoreHeight: status.restoreHeight }
  const scanned = status.walletHeight > 0
  const state: MoneroBalanceState = refreshError ? 'unreachable' : status.syncState === 'not-connected' ? 'scanning' : status.syncState
  const caughtUp = scanned && status.daemonHeight !== undefined && status.walletHeight >= status.daemonHeight
  const showBalance = scanned && (state === 'ready' || state === 'unreachable' || caughtUp)
  const balance = BigInt(status.balanceAtomic), unlocked = BigInt(status.unlockedBalanceAtomic)
  let progress: number | undefined
  if (state === 'scanning' && scanned && status.daemonHeight !== undefined) {
    const start = status.restoreHeight ?? 0, span = status.daemonHeight - start
    progress = span > 0 ? Math.min(1, Math.max(0, (status.walletHeight - start) / span)) : 1
  }
  return {
    state, ...heights, ...(progress === undefined ? {} : { progress }), ...(status.updatedAt ? { updatedAt: status.updatedAt } : {}),
    balanceAtomic: showBalance ? balance.toString() : null,
    unlockedAtomic: showBalance ? unlocked.toString() : null,
    lockedAtomic: showBalance ? (balance - unlocked).toString() : null,
    spendVerified: showBalance && status.spendStateKnown === true,
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
