/**
 * Tests for classifyDefiPosition / normalizeDefiPositions — the pure functions
 * that decide whether a Zapper portfolio item is a DeFi position and normalize
 * it for the UI.
 *
 * DeFi rule: an item is DeFi when ANY of tokenType === 'contract-position',
 * appId, groupId, or metaType is present. Plain wallet tokens (which Pioneer
 * already serves) are dropped so the DeFi section never duplicates them.
 *
 * Run: bun test __tests__/defi-classify.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { classifyDefiPosition, normalizeDefiPositions } from '../src/bun/zapper'

describe('classifyDefiPosition — DeFi detection', () => {
  test('contract-position tokenType is DeFi', () => {
    const pos = classifyDefiPosition({ tokenType: 'contract-position', symbol: 'ETH', balanceUSD: 100 })
    expect(pos).not.toBeNull()
    expect(pos!.isDefi).toBe(true)
    expect(pos!.type).toBe('contract-position')
  })

  test('appId presence marks DeFi and populates protocol', () => {
    const pos = classifyDefiPosition({ tokenType: 'app-token', appId: 'aave-v3', symbol: 'aUSDC', balanceUSD: 50 })
    expect(pos).not.toBeNull()
    expect(pos!.isDefi).toBe(true)
    expect(pos!.protocol).toBe('aave-v3')
  })

  test('groupId presence marks DeFi', () => {
    const pos = classifyDefiPosition({ groupId: 'supply', symbol: 'DAI', balanceUSD: 10 })
    expect(pos).not.toBeNull()
    expect(pos!.isDefi).toBe(true)
  })

  test('metaType presence marks DeFi and is normalized', () => {
    const pos = classifyDefiPosition({ metaType: 'borrowed', symbol: 'USDT', balanceUSD: 5 })
    expect(pos).not.toBeNull()
    expect(pos!.metaType).toBe('borrowed')
  })

  test('plain wallet token (no markers) is NOT DeFi → null', () => {
    expect(classifyDefiPosition({ tokenType: 'token', symbol: 'USDC', balanceUSD: 1000 })).toBeNull()
  })

  test('protocol is null when no appId even if DeFi by other markers', () => {
    const pos = classifyDefiPosition({ tokenType: 'contract-position', metaType: 'staked', symbol: 'ETH', balanceUSD: 1 })
    expect(pos!.protocol).toBeNull()
  })

  test('null / non-object input returns null', () => {
    expect(classifyDefiPosition(null)).toBeNull()
    expect(classifyDefiPosition(undefined)).toBeNull()
    expect(classifyDefiPosition('nope' as any)).toBeNull()
  })
})

describe('classifyDefiPosition — field normalization', () => {
  test('prefers displayProps.label for name and first image for icon', () => {
    const pos = classifyDefiPosition({
      tokenType: 'contract-position',
      appId: 'uniswap-v3',
      symbol: 'UNI-V3',
      network: 'Ethereum',
      metaType: 'liquidity',
      balance: '2.5',
      balanceUSD: 1234.5,
      displayProps: { label: 'ETH / USDC LP', images: ['https://img/lp.png', 'https://img/2.png'] },
    })
    expect(pos!.name).toBe('ETH / USDC LP')
    expect(pos!.icon).toBe('https://img/lp.png')
    expect(pos!.network).toBe('ethereum') // lowercased
    expect(pos!.balance).toBe('2.5')
    expect(pos!.balanceUsd).toBe(1234.5)
  })

  test('falls back across alternate field names (balanceUsd / value / iconUrl)', () => {
    const pos = classifyDefiPosition({ appId: 'lido', symbol: 'stETH', balanceUsd: 42, iconUrl: 'https://img/lido.png' })
    expect(pos!.balanceUsd).toBe(42)
    expect(pos!.icon).toBe('https://img/lido.png')
  })

  test('defaults balanceUsd to 0 and balance to "0" when absent', () => {
    const pos = classifyDefiPosition({ appId: 'compound' })
    expect(pos!.balanceUsd).toBe(0)
    expect(pos!.balance).toBe('0')
  })
})

describe('normalizeDefiPositions', () => {
  const items = [
    { tokenType: 'token', symbol: 'USDC', balanceUSD: 5000 },             // plain token → dropped
    { appId: 'aave-v3', metaType: 'supplied', symbol: 'aUSDC', balanceUSD: 100 },
    { tokenType: 'contract-position', appId: 'uniswap-v3', symbol: 'LP', balanceUSD: 900 },
  ]

  test('drops plain tokens and keeps only DeFi positions', () => {
    const out = normalizeDefiPositions({ balances: items })
    expect(out.length).toBe(2)
    expect(out.every(p => p.isDefi)).toBe(true)
  })

  test('sorts by USD value descending', () => {
    const out = normalizeDefiPositions(items)
    expect(out[0].balanceUsd).toBe(900)
    expect(out[1].balanceUsd).toBe(100)
  })

  test('unwraps array / positions / data shapes', () => {
    expect(normalizeDefiPositions(items).length).toBe(2)
    expect(normalizeDefiPositions({ positions: items }).length).toBe(2)
    expect(normalizeDefiPositions({ data: { balances: items } }).length).toBe(2)
    expect(normalizeDefiPositions({ data: items }).length).toBe(2)
  })

  test('tolerates empty / malformed input', () => {
    expect(normalizeDefiPositions(null)).toEqual([])
    expect(normalizeDefiPositions({})).toEqual([])
    expect(normalizeDefiPositions({ balances: 'nope' })).toEqual([])
  })
})
