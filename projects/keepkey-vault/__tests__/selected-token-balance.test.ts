import { describe, expect, test } from 'bun:test'
import type { ChainBalance, TokenBalance } from '../src/shared/types'
import { DIRECT_TOKEN_PROOF_MAX_AGE_MS, applyNativeProof, reconcileSelectedToken, type DirectNativeProof, type DirectTokenProof, type SelectedTokenState } from '../src/shared/selected-token-balance'
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

// The selected token's own balanceOf, read on chain for one owner. It is the
// only way a token can be trusted while its chain's portfolio is degraded,
// e.g. when the token-discovery provider is down (Zapper 525, 2026-11-11).
describe('on-chain proof for the selected token', () => {
  const verifiedAt = 1_000_000
  const now = verifiedAt + 5_000
  const proof = (overrides: Partial<DirectTokenProof> = {}): DirectTokenProof =>
    ({ chainId: 'ethereum', owner, caip, balance: '17500.5', verifiedAt, ...overrides })

  test('a fresh proof for this owner verifies the token while the chain is degraded', () => {
    const result = reconcileSelectedToken(selected(), context, balance('100', { syncState: 'degraded' }), proof(), now)
    expect(result.unverified).toBe(false)
    expect(result.selection!.token.balance).toBe('17500.5')
    expect(result.selection!.token.balanceUsd).toBe(17500.5)
    expect(result.selection!.ownerAddress).toBe(owner)
  })

  test('the proof also covers an owner whose portfolio never loaded or went stale', () => {
    expect(reconcileSelectedToken(selected(), context, undefined, proof(), now).unverified).toBe(false)
    expect(reconcileSelectedToken(selected(), context, balance('1', { syncState: 'stale' }), proof(), now).unverified).toBe(false)
  })

  test('a proven zero is a verified zero', () => {
    const result = reconcileSelectedToken(selected(), context, balance('100', { syncState: 'degraded' }), proof({ balance: '0' }), now)
    expect(result.unverified).toBe(false)
    expect(result.selection!.token.balance).toBe('0')
    expect(result.selection!.token.balanceUsd).toBe(0)
  })

  test('owner matching ignores EVM address case', () => {
    const result = reconcileSelectedToken(selected(), context, balance('1', { syncState: 'degraded' }), proof({ owner: owner.toUpperCase().replace('0X', '0x') }), now)
    expect(result.unverified).toBe(false)
  })

  test('a proof for another owner, chain or token, or an old or future one, is ignored', () => {
    const degraded = balance('100', { syncState: 'degraded' })
    for (const bad of [
      proof({ owner: other }),
      proof({ chainId: 'base' }),
      proof({ caip: 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' }),
      proof({ verifiedAt: now - DIRECT_TOKEN_PROOF_MAX_AGE_MS - 1 }),
      proof({ verifiedAt: now + 1 }),
    ]) {
      const result = reconcileSelectedToken(selected(), context, degraded, bad, now)
      expect(result.unverified).toBe(true)
      expect(result.selection!.token.balance).toBe('100')
    }
  })

  test('a trusted portfolio still wins over a proof', () => {
    const result = reconcileSelectedToken(selected(), context, balance('42'), proof(), now)
    expect(result.unverified).toBe(false)
    expect(result.selection!.token.balance).toBe('42')
  })
})

describe('native balance proof while degraded (audit v4 H4)', () => {
  const native = 'eip155:1/slip44:60'
  const degraded = () => balance(undefined, { syncState: 'degraded', balance: '0.002', nativeBalanceUsd: 6, balanceUsd: 10 })
  const proof = (o: Partial<DirectNativeProof> = {}): DirectNativeProof => ({ chainId: 'ethereum', owner: owner.toUpperCase().replace('0X', '0x'), balance: '0.003', verifiedAt: 1000, ...o })
  test('a fresh proof for the owner verifies the native coin', () => {
    const b = applyNativeProof(degraded(), native, proof(), 2000)!
    expect(isBalanceUnverified(b, native)).toBe(false)
    expect(b.balance).toBe('0.003')
    expect(b.nativeBalanceUsd).toBeCloseTo(9)
    expect(b.balanceUsd).toBeCloseTo(13)
  })
  test('wrong owner, wrong chain or stale proof changes nothing', () => {
    for (const p of [proof({ owner: other }), proof({ chainId: 'base' }), proof({ verifiedAt: 1000 - DIRECT_TOKEN_PROOF_MAX_AGE_MS - 1 })]) {
      expect(isBalanceUnverified(applyNativeProof(degraded(), native, p, 1000), native)).toBe(true)
    }
  })
  test('a trusted portfolio wins over the proof', () => {
    const b = balance(undefined)
    expect(applyNativeProof(b, native, proof(), 2000)).toBe(b)
  })
})
