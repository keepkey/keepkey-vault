import { describe, expect, test } from 'bun:test'
import type { MoneroStatus } from './types'
import { formatXmrShort, moneroBalanceView, moneroChainVisible, moneroSendInputProblems } from './monero-asset'

const WALLET = '44jKQv6ZKMd5ecLLmkNJGi7azgSptEq8ki7TFiat1TfLfdDQ1tQ7ZYa3cRh7X2uRwvLDjddWh97ajeyhR2seKSECQeDx1WR'
const RECIPIENT = '4Ahp23WfMrMFK3wYL2hLWQFGt87ZTeRkufS6JoQZu6MEFDokAQeGWmu9MA3GFq1yVLSJQbKJqVAn9F9DLYGpRzRAEXqAXKM'
const SUBADDRESS = '84AxZu7xYb7fi7hnQrgTBdHFyP2xz6vdrZbLaJxbe73JJTWj6JG4cV8cbNnEhMvvi9PxSHvGnXQiaaLf2HNXJfzFKtWqk3H'
const INTEGRATED = '4LL9oSLmtpccfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2bYXZKKQePHES9khPK'
const status = (over: Partial<MoneroStatus> = {}): MoneroStatus => ({ available: true, network: 'mainnet', address: WALLET,
  balanceAtomic: '84653050000', unlockedBalanceAtomic: '80000000000', walletHeight: 3_300_000, transactions: [], monitorReady: true,
  syncState: 'ready', canSend: false, spendStateKnown: false, daemonHeight: 3_300_000, restoreHeight: 3_200_000, updatedAt: '2026-11-06T12:00:00.000Z', ...over })

describe('C1: the XMR row is gated exactly as the old tab', () => {
  test('setting AND firmware 7.17+, on a connected multi-coin wallet', () => {
    expect(moneroChainVisible({ settingEnabled: true, firmwareVersion: '7.17.0' })).toBe(true)
    expect(moneroChainVisible({ settingEnabled: false, firmwareVersion: '7.17.0' })).toBe(false)
    expect(moneroChainVisible({ settingEnabled: true, firmwareVersion: '7.16.0' })).toBe(false)
    expect(moneroChainVisible({ settingEnabled: true })).toBe(false)
    expect(moneroChainVisible({ settingEnabled: true, firmwareVersion: '7.17.0', watchOnly: true })).toBe(false)
    expect(moneroChainVisible({ settingEnabled: true, firmwareVersion: '7.17.0', bitcoinOnly: true })).toBe(false)
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
  test('row amounts keep exact digits', () => {
    expect(formatXmrShort('84653050000')).toBe('0.08465305')
    expect(formatXmrShort('1')).toBe('0.000000000001')
    expect(formatXmrShort('2000000000000')).toBe('2.0')
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
