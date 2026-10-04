import { expect, test } from 'bun:test'
import { cachedHistoryQueries, watchOnlyWalletScope, watchOnlyBitcoinScope } from '../src/bun/watch-only-history'
import { CHAINS } from '../src/shared/chains'
import type { ChainBalance } from '../src/shared/types'

test('history scope uses the selected device and persisted seed, never device-only scope', () => {
  const address = '0x27de622cc44c55b53caF299eCedccdAB29aC98A8'
  expect(watchOnlyWalletScope('selected-device', address)?.walletId).toBe(`selected-device:${address.toLowerCase()}`)
  expect(watchOnlyWalletScope('selected-device', null)).toBeNull()
  expect(watchOnlyWalletScope('selected-device', 'bad')).toBeNull()
  expect(watchOnlyWalletScope('', address)).toBeNull()
})

test('Bitcoin-only history has a stable scope from saved xpubs', () => {
  const keys = [{ chainId: 'bitcoin', xpub: 'xpub-1' }, { chainId: 'bitcoin', xpub: 'xpub-2' }]
  const first = watchOnlyBitcoinScope('btc-device', keys)
  expect(first?.walletId).toBe(watchOnlyBitcoinScope('btc-device', [...keys].reverse())?.walletId)
  expect(first?.walletId).not.toBe(watchOnlyBitcoinScope('other-device', keys)?.walletId)
  expect(first?.walletId).not.toContain('xpub-1')
  expect(watchOnlyBitcoinScope('btc-device', [])).toBeNull()
})

test('cached EVM history scans all saved accounts and deduplicates balance addresses', () => {
  const chain = CHAINS.find(c => c.id === 'ethereum')!
  const balances = [{ chainId: 'ethereum', address: '0xfirst' }, { chainId: 'base', address: '0xother' }] as ChainBalance[]
  const pubkeys = ['0xfirst', '0xsecond'].map(address => ({ chainId: 'ethereum', address, xpub: '', path: '', scriptType: '' }))
  expect(cachedHistoryQueries(chain, balances, pubkeys).map(q => q.pubkey)).toEqual(['0xfirst', '0xsecond'])
})

test('UTXO scans do not substitute a cached receive address for an account xpub', () => {
  const chain = CHAINS.find(c => c.id === 'bitcoin')!
  expect(cachedHistoryQueries(chain, [{ chainId: 'bitcoin', address: 'bc1qaddress' }] as ChainBalance[], [])).toEqual([])
})
