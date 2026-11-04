import { expect, test } from 'bun:test'
import { ownerPortfolioConfidence } from '../src/shared/balance-display-state'
const eth = 'eip155:1/slip44:60', usdt = 'eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7'
const rows = [{ caip: eth, pubkey: '0xOwnerA', balance: '0.01' }, { caip: usdt, pubkey: '0xOwnerB', balance: '20' }]
test('a fresh owner response can establish its token omission without borrowing another owner balance', () => {
  expect(ownerPortfolioConfidence(rows, '0xownera', eth, undefined, 123)).toEqual({ syncState: 'confirmed', updatedAt: 123, confirmedAssetCaips: [eth] })
  expect(ownerPortfolioConfidence(rows, '0xownerb', eth, undefined, 123)).toMatchObject({ syncState: 'degraded', confirmedAssetCaips: [] })
})
test('fresh explicit zero token rows retain their own asset confirmation', () => {
  expect(ownerPortfolioConfidence([...rows, { caip: usdt, pubkey: '0xOwnerA', balance: '0' }], '0xownera', eth).confirmedAssetCaips).toEqual([eth, usdt])
})
test('partial, stale and malformed responses cannot establish a zero for an omitted token', () => {
  expect(ownerPortfolioConfidence(rows, '0xownera', eth, { degraded: true }).syncState).toBe('degraded')
  expect(ownerPortfolioConfidence(rows, '0xownera', eth, { failures: ['provider unavailable'] }).confirmedAssetCaips).toEqual([])
  expect(ownerPortfolioConfidence(rows, '0xownera', eth, { staleChains: ['ethereum'] }).syncState).toBe('stale')
  for (const extra of [{ isStale: true }, { verified: false }, { balance: '' }, { balance: 'NaN' }]) {
    expect(ownerPortfolioConfidence([{ ...rows[0], ...extra }], '0xownera', eth).confirmedAssetCaips).toEqual([])
  }
  expect(ownerPortfolioConfidence([{ ...rows[0], caip: 'eip155:8453/slip44:60' }], '0xownera', eth).syncState).toBe('degraded')
})
