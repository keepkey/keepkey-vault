import { describe, expect, test } from 'bun:test'
import type { ChainBalance, TokenBalance } from '../src/shared/types'
import { reconcileSelectedToken, type SelectedTokenState } from '../src/shared/selected-token-balance'
import { isBalanceUnverified } from '../src/shared/balance-display-state'

const owner = '0x1111111111111111111111111111111111111111'
const other = '0x2222222222222222222222222222222222222222'
const caip = 'eip155:1/erc20:0xDAc17f958D2ee523a2206206994597C13D831ec7'
const context = { chainId: 'ethereum', chainCaip: 'eip155:1/slip44:60', ownerAddress: owner }
const token: TokenBalance = { caip, symbol: 'USDT', name: 'Tether', balance: '100', balanceUsd: 100,
  priceUsd: 1, decimals: 6, contractAddress: caip.split('erc20:')[1], icon: 'saved-icon', type: 'token' }
const selected = (): SelectedTokenState => ({ token: { ...token }, chainId: 'ethereum', ownerAddress: owner })
const balance = (amount?: string, overrides: Partial<ChainBalance> = {}): ChainBalance => ({
  chainId: 'ethereum', symbol: 'ETH', address: owner, balance: '1', balanceUsd: 3000,
  syncState: 'confirmed', updatedAt: 2,
  tokens: amount === undefined ? [] : [{ ...token, caip: caip.toLowerCase(), balance: amount, balanceUsd: Number(amount) }],
  ...overrides,
})

describe('selected token live balance', () => {
  test('updates a nonzero post-send amount without replacing selected asset metadata', () => {
    const live = balance('35.123456')
    live.tokens![0] = { ...live.tokens![0], symbol: 'different label', name: 'upstream label', icon: undefined, decimals: undefined }
    const result = reconcileSelectedToken(selected(), context, live)
    expect(result.unverified).toBe(false)
    expect(result.selection!.token).toEqual({ ...token, balance: '35.123456', balanceUsd: 35.123456, pendingBalance: undefined, dataSource: undefined })
    expect(result.selection!.ownerAddress).toBe(owner)
    expect(token.balance).toBe('100')
  })

  test('MAX omission becomes zero only from an authoritative current-owner response', () => {
    for (const tokens of [[], undefined]) {
      const result = reconcileSelectedToken(selected(), context, balance(undefined, { tokens }))
      expect(result.unverified).toBe(false)
      expect(result.selection!.token.balance).toBe('0')
      expect(result.selection!.token.balanceUsd).toBe(0)
      expect(result.selection!.token.caip).toBe(caip)
      expect(result.selection!.token.decimals).toBe(6)
    }
    const unmarked = reconcileSelectedToken(selected(), context, balance(undefined, { syncState: undefined }))
    expect(unmarked.unverified).toBe(true)
    expect(unmarked.selection!.token.balance).toBe('100')
  })

  test('failed and stale refreshes retain the newest known amount as unverified', () => {
    const latest = reconcileSelectedToken(selected(), context, balance('12.5')).selection
    for (const syncState of ['degraded', 'stale'] as const) {
      const result = reconcileSelectedToken(latest, context, balance('0', { syncState }))
      expect(result.selection).toBe(latest)
      expect(result.selection!.token.balance).toBe('12.5')
      expect(result.unverified).toBe(true)
    }
    const missing = reconcileSelectedToken(latest, context)
    expect(missing.selection).toBe(latest)
    expect(missing.unverified).toBe(true)
  })

  test('does not restore an old nonzero amount after a fresh confirmed zero', () => {
    const zero = reconcileSelectedToken(selected(), context, balance()).selection
    const result = reconcileSelectedToken(zero, context, balance('100', { syncState: 'stale' }))
    expect(result.selection!.token.balance).toBe('0')
    expect(result.unverified).toBe(true)
  })

  test('does not borrow another owner or chain and clears selection on a context switch', () => {
    const initial = selected()
    expect(reconcileSelectedToken(initial, context, balance('500', { address: other }))).toEqual({ selection: initial, unverified: true })
    expect(reconcileSelectedToken(initial, context, balance('500', { chainId: 'arbitrum' }))).toEqual({ selection: initial, unverified: true })
    expect(reconcileSelectedToken(initial, { ...context, ownerAddress: other }, balance('500', { address: other })).selection).toBeNull()
    expect(reconcileSelectedToken(initial, { ...context, chainId: 'arbitrum', chainCaip: 'eip155:42161/slip44:60' }).selection).toBeNull()
  })

  test('an initially unbound dashboard token waits for the selected owner cache', () => {
    const initial = { ...selected(), ownerAddress: undefined }
    const pending = reconcileSelectedToken(initial, context)
    expect(pending.unverified).toBe(true)
    expect(pending.selection!.ownerAddress).toBeUndefined()
    const result = reconcileSelectedToken(pending.selection, context, balance('9'))
    expect(result.selection!.ownerAddress).toBe(owner)
    expect(result.selection!.token.balance).toBe('9')
    expect(result.unverified).toBe(false)
  })

  test('direct asset proof can update a token on a degraded chain without vouching for native gas', () => {
    const live = balance('0', { syncState: 'degraded', confirmedAssetCaips: [caip.toLowerCase()] })
    const result = reconcileSelectedToken(selected(), context, live)
    expect(result.unverified).toBe(false)
    expect(result.selection!.token.balance).toBe('0')
    expect(isBalanceUnverified(live, context.chainCaip)).toBe(true)
    const freshNative = balance(undefined, { syncState: undefined })
    expect(reconcileSelectedToken(selected(), context, freshNative).unverified).toBe(true)
    expect(isBalanceUnverified(freshNative, context.chainCaip)).toBe(false)
  })

  test('keeps non-EVM token and owner case significant', () => {
    const network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    const solToken = { ...token, caip: `${network}/token:${mint}` }
    const solContext = { chainId: 'solana', chainCaip: `${network}/slip44:501`, ownerAddress: 'OwnerCase' }
    const solSelected = { token: solToken, chainId: 'solana', ownerAddress: 'OwnerCase' }
    const live = balance('5', { chainId: 'solana', address: 'OwnerCase', tokens: [{ ...solToken, caip: solToken.caip.toLowerCase(), balance: '500' }] })
    expect(reconcileSelectedToken(solSelected, solContext, live).selection!.token.balance).toBe('0')
    expect(reconcileSelectedToken(solSelected, { ...solContext, ownerAddress: 'ownercase' }, live).selection).toBeNull()
  })

  test('preserves state reference after an unchanged live result', () => {
    const first = reconcileSelectedToken(selected(), context, balance('25')).selection
    expect(reconcileSelectedToken(first, context, balance('25')).selection).toBe(first)
  })
})
