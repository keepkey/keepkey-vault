import { describe, expect, test } from 'bun:test'
import type { MoneroStatus } from './types'
import { formatXmrShort, moneroBalanceView, moneroChainVisible, moneroSendInputProblems, moneroWalletScanProgress } from './monero-asset'

const WALLET = '44jKQv6ZKMd5ecLLmkNJGi7azgSptEq8ki7TFiat1TfLfdDQ1tQ7ZYa3cRh7X2uRwvLDjddWh97ajeyhR2seKSECQeDx1WR'
const RECIPIENT = '4Ahp23WfMrMFK3wYL2hLWQFGt87ZTeRkufS6JoQZu6MEFDokAQeGWmu9MA3GFq1yVLSJQbKJqVAn9F9DLYGpRzRAEXqAXKM'
const SUBADDRESS = '84AxZu7xYb7fi7hnQrgTBdHFyP2xz6vdrZbLaJxbe73JJTWj6JG4cV8cbNnEhMvvi9PxSHvGnXQiaaLf2HNXJfzFKtWqk3H'
const INTEGRATED = '4LL9oSLmtpccfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2bYXZKKQePHES9khPK'
const status = (over: Partial<MoneroStatus> = {}): MoneroStatus => ({ signingReady: true, available: true, network: 'mainnet', address: WALLET,
  balanceAtomic: '84653050000', unlockedBalanceAtomic: '80000000000', walletHeight: 3_300_000, transactions: [], monitorReady: true,
  syncState: 'ready', canSend: false, spendStateKnown: false, daemonHeight: 3_300_000, restoreHeight: 3_200_000, updatedAt: '2026-11-06T12:00:00.000Z', ...over })

describe('C1: the XMR row uses device capabilities', () => {
  test('setting AND monero-signing capability, on a connected multi-coin wallet', () => {
    expect(moneroChainVisible({ settingEnabled: true, capabilities: [31] })).toBe(true)
    expect(moneroChainVisible({ settingEnabled: false, capabilities: [31] })).toBe(false)
    expect(moneroChainVisible({ settingEnabled: true, capabilities: [30] })).toBe(false)
    expect(moneroChainVisible({ settingEnabled: true })).toBe(false)
    expect(moneroChainVisible({ settingEnabled: true, isEmulator: true })).toBe(true)
    expect(moneroChainVisible({ settingEnabled: true, capabilities: [31], watchOnly: true })).toBe(false)
    expect(moneroChainVisible({ settingEnabled: true, capabilities: [31], bitcoinOnly: true })).toBe(false)
  })
})

describe('C2: never a fake 0', () => {
  test('loading and not connected are "—"', () => {
    expect(moneroBalanceView(null)).toMatchObject({ state: 'loading', balanceAtomic: null })
    expect(moneroBalanceView(status({ available: false, syncState: 'not-connected', balanceAtomic: '0' }))).toMatchObject({ state: 'not-connected', balanceAtomic: null, unlockedAtomic: null })
  })
  test('scanning shows progress and no balance, even a nonzero part-scanned one', () => {
    expect(moneroBalanceView(status({ syncState: 'scanning', walletHeight: 0, balanceAtomic: '0' }))).toMatchObject({ state: 'scanning', balanceAtomic: null })
    const half = moneroBalanceView(status({ syncState: 'scanning', walletHeight: 3_250_000, monitorReady: false }))
    expect(half).toMatchObject({ state: 'scanning', balanceAtomic: null, progress: 0.5 })
  })
  test('node down keeps the last known balance with its time; with none, "—"', () => {
    expect(moneroBalanceView(status({ syncState: 'unreachable', monitorReady: false }))).toMatchObject({ state: 'unreachable', balanceAtomic: '84653050000', updatedAt: '2026-11-06T12:00:00.000Z' })
    expect(moneroBalanceView(status({ syncState: 'unreachable', walletHeight: 0 }))).toMatchObject({ state: 'unreachable', balanceAtomic: null })
    // The app's own status RPC failing keeps the last status it had, now labelled unreachable.
    expect(moneroBalanceView(status(), 'timeout')).toMatchObject({ state: 'unreachable', balanceAtomic: '84653050000' })
    expect(moneroBalanceView(null, 'timeout')).toMatchObject({ state: 'unreachable', balanceAtomic: null })
  })
  test('received but not verified spendable until key images are synced', () => {
    expect(moneroBalanceView(status())).toMatchObject({ state: 'ready', balanceAtomic: '84653050000', unlockedAtomic: '80000000000', lockedAtomic: '4653050000', spendVerified: false })
    expect(moneroBalanceView(status({ spendStateKnown: true })).spendVerified).toBe(true)
  })
  test('an old figure is marked stale with its time, whatever the state; a fresh one is not', () => {
    const at = Date.parse('2026-11-06T12:00:00.000Z')
    expect(moneroBalanceView(status(), null, at + 60_000).stale).toBe(false)
    expect(moneroBalanceView(status(), null, at + 10 * 60_000)).toMatchObject({ stale: true, updatedAt: '2026-11-06T12:00:00.000Z' })
    // Caught up to the node's own height but not refreshed lately: still labelled with its time.
    expect(moneroBalanceView(status({ syncState: 'scanning', monitorReady: false }), null, at + 10 * 60_000)).toMatchObject({ balanceAtomic: '84653050000', stale: true })
    expect(moneroBalanceView(status({ available: false, syncState: 'not-connected' }), null, at + 10 * 60_000).stale).toBe(false)
  })
  test('row amounts keep exact digits', () => {
    expect(formatXmrShort('84653050000')).toBe('0.08465305')
    expect(formatXmrShort('1')).toBe('0.000000000001')
    expect(formatXmrShort('2000000000000')).toBe('2.0')
  })
})

describe('wallet-scoped saved XMR balance', () => {
  const cachedBalance = { balanceAtomic: '84653050000', unlockedBalanceAtomic: '80000000000', walletHeight: 3_300_000,
    updatedAt: '2026-11-06T12:00:00.000Z', spendStateKnown: true }
  test('startup restores only the saved total and source time, never spendability', () => {
    expect(moneroBalanceView(status({ available: false, syncState: 'not-connected', walletHeight: 0, balanceAtomic: '0', unlockedBalanceAtomic: '0', cachedBalance })))
      .toMatchObject({ state: 'not-connected', balanceAtomic: '84653050000', unlockedAtomic: null, lockedAtomic: null,
        updatedAt: cachedBalance.updatedAt, stale: true, spendVerified: false, lastKnown: true })
  })
  test('partial scans and offline reads preserve the saved total instead of showing a partial or fake zero', () => {
    expect(moneroBalanceView(status({ syncState: 'scanning', walletHeight: 3_250_000, balanceAtomic: '1', monitorReady: false, cachedBalance })))
      .toMatchObject({ state: 'scanning', balanceAtomic: cachedBalance.balanceAtomic, progress: 0.5, lastKnown: true, spendVerified: false })
    expect(moneroBalanceView(status({ available: false, syncState: 'unreachable', walletHeight: 0, balanceAtomic: '0', cachedBalance })))
      .toMatchObject({ state: 'unreachable', balanceAtomic: cachedBalance.balanceAtomic, updatedAt: cachedBalance.updatedAt, lastKnown: true, spendVerified: false })
    expect(moneroBalanceView(status({ cachedBalance }), 'timeout')).toMatchObject({ state: 'unreachable', balanceAtomic: cachedBalance.balanceAtomic, lastKnown: true })
  })
  test('a current verified observation and a fully scanned zero replace an older saved amount', () => {
    const fresh = moneroBalanceView(status({ balanceAtomic: '90000000000', unlockedBalanceAtomic: '85000000000', spendStateKnown: true, cachedBalance }))
    expect(fresh).toMatchObject({ state: 'ready', balanceAtomic: '90000000000', unlockedAtomic: '85000000000', spendVerified: true })
    expect(fresh.lastKnown).not.toBe(true)
    const zero = moneroBalanceView(status({ balanceAtomic: '0', unlockedBalanceAtomic: '0', spendStateKnown: false, cachedBalance }))
    expect(zero).toMatchObject({ state: 'ready', balanceAtomic: '0', unlockedAtomic: '0', spendVerified: false })
    expect(zero.lastKnown).not.toBe(true)
  })
  test('a new view-only received total cannot inflate a prior spend-verified saved balance', () => {
    const verified = { ...cachedBalance, balanceAtomic: '500000000000', unlockedBalanceAtomic: '500000000000' }
    expect(moneroBalanceView(status({ balanceAtomic: '1000000000000', unlockedBalanceAtomic: '1000000000000', spendStateKnown: false, cachedBalance: verified })))
      .toMatchObject({ state: 'ready', balanceAtomic: '500000000000', unlockedAtomic: null, lockedAtomic: null,
        updatedAt: verified.updatedAt, lastKnown: true, spendVerified: false })
  })
  test('a saved zero remains a dated snapshot; a wallet without a snapshot inherits no amount', () => {
    expect(moneroBalanceView(status({ available: false, cachedBalance: { ...cachedBalance, balanceAtomic: '0', unlockedBalanceAtomic: '0' } })))
      .toMatchObject({ balanceAtomic: '0', unlockedAtomic: null, spendVerified: false, lastKnown: true, stale: true })
    expect(moneroBalanceView(status({ available: false, cachedBalance: undefined })))
      .toMatchObject({ balanceAtomic: null, unlockedAtomic: null, spendVerified: false, stale: false })
  })
})

describe('wallet scan progress counts the selected block range', () => {
  test('a saved start is the baseline, and a changing observed target changes the measured fraction', () => {
    expect(moneroWalletScanProgress({ walletHeight: 3_250_000, daemonHeight: 3_300_000, restoreHeight: 3_200_000 })).toBe(0.5)
    expect(moneroWalletScanProgress({ walletHeight: 100, daemonHeight: 200 })).toBe(0.5)
    expect(moneroWalletScanProgress({ walletHeight: 3_250_000, daemonHeight: 3_400_000, restoreHeight: 3_200_000 })).toBe(0.25)
    expect(moneroWalletScanProgress({ walletHeight: 3_199_000, daemonHeight: 3_300_000, restoreHeight: 3_200_000 })).toBe(0)
  })
  test('zero or unreported wallet height and invalid targets/ranges never manufacture a percentage', () => {
    const valid = { walletHeight: 3_250_000, daemonHeight: 3_300_000, restoreHeight: 3_200_000 }
    for (const value of [0, undefined, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(moneroWalletScanProgress({ ...valid, walletHeight: value })).toBeUndefined()
      expect(moneroWalletScanProgress({ ...valid, daemonHeight: value })).toBeUndefined()
    }
    for (const restoreHeight of [-1, 0.5, NaN, Infinity, 3_300_000, 3_300_001]) {
      expect(moneroWalletScanProgress({ ...valid, restoreHeight })).toBeUndefined()
    }
  })
  test('a scan is not presented as complete until the wallet reports ready', () => {
    for (const walletHeight of [3_300_000, 3_300_001]) {
      expect(moneroBalanceView(status({ syncState: 'scanning', monitorReady: false, walletHeight })).progress).toBeUndefined()
    }
    expect(moneroBalanceView(status()).progress).toBeUndefined()
    expect(moneroBalanceView(status({ syncState: 'unreachable' })).progress).toBeUndefined()
  })
})

describe('C3: form checks before the wallet is asked', () => {
  const check = (address: string, amount: string, max = false) => moneroSendInputProblems({ address, amount, max, walletAddress: WALLET, unlockedAtomic: '80000000000' })
  test('addresses: standard and subaddress pass; integrated, invalid and my own main address are named', () => {
    expect(check(RECIPIENT, '0.01').address).toBeUndefined()
    expect(check(SUBADDRESS, '0.01').address).toBeUndefined()
    expect(check(INTEGRATED, '0.01').address).toBe('integrated')
    expect(check('4abc', '0.01').address).toBe('invalid-address')
    expect(check(WALLET, '0.01').address).toBe('own-address')
  })
  test('amounts: more than unlocked, too many decimals, dust passes to the backend fee check, Max needs none', () => {
    expect(check(RECIPIENT, '0.09').amount).toBe('more-than-unlocked')
    expect(check(RECIPIENT, '0.08')).toEqual({ amountAtomic: '80000000000' })
    expect(check(RECIPIENT, '0.0000000000001').amount).toBe('invalid-amount')
    expect(check(RECIPIENT, '0.000000000001')).toEqual({ amountAtomic: '1' })
    expect(check(RECIPIENT, '', true)).toEqual({ amountAtomic: null })
  })
})
