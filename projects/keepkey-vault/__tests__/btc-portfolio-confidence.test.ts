import { describe, expect, test } from 'bun:test'
import { confirmedPortfolioNativeMatches, type PortfolioKey } from '../src/bun/watch-only-portfolio'
import { utxoDiscoveryKey } from '../src/bun/btc-backend/types'
import { mergeTrustedBalanceSnapshot } from '../src/shared/balance-reconciliation'

const caip = 'bip122:000000000019d6689c085ae165831e93/slip44:0'
const keys: PortfolioKey[] = ['p2pkh', 'p2wpkh', 'p2tr'].map((scriptType, index) => ({
  caip, pubkey: utxoDiscoveryKey(`xpub-account-${index}`, scriptType), sourcePubkey: `xpub-account-${index}`,
  chainId: 'bitcoin', symbol: 'BTC', networkId: caip.split('/')[0], path: `m/84'/0'/${index}'`, scriptType,
}))
const response = () => keys.map(key => ({ caip, pubkey: key.pubkey, balance: '0', valueUsd: 0 }))
const inspect = (entries: any[], failed = new Set<string>()) => confirmedPortfolioNativeMatches(keys, entries, failed)

describe('BTC portfolio response completeness', () => {
  test('a complete set of explicit zero rows confirms an empty balance', () => {
    const result = inspect(response())
    expect(result.confirmed).toBe(true)
    expect([...result.matches.values()].map(row => row.balance)).toEqual(['0', '0', '0'])
  })

  test('an HTTP 200 response omitting any requested account cannot confirm zero', () => {
    for (let omitted = 0; omitted < keys.length; omitted++) {
      const result = inspect(response().filter((_, index) => index !== omitted))
      expect(result.confirmed).toBe(false)
      expect(result.matches.has(keys[omitted].pubkey)).toBe(false)
    }
    expect(inspect([]).confirmed).toBe(false)
    expect(confirmedPortfolioNativeMatches([], [], new Set()).confirmed).toBe(false)
  })

  test('query wrappers and original xpub response owners both match their own account', () => {
    expect(inspect(response()).confirmed).toBe(true)
    const sourceOwners = response().map((row, index) => ({ ...row, pubkey: keys[index].sourcePubkey }))
    expect(inspect(sourceOwners).confirmed).toBe(true)
    const addressOwners = sourceOwners.map(({ pubkey, ...row }) => ({ ...row, address: pubkey }))
    expect(inspect(addressOwners).confirmed).toBe(true)
    const mixedCaseXpub = sourceOwners.map((row, index) => index ? row : { ...row, pubkey: row.pubkey!.toUpperCase() })
    expect(inspect(mixedCaseXpub).confirmed).toBe(false)
  })

  test('a failed script-qualified query is unconfirmed even when a native row exists', () => {
    const key = keys[2]
    expect(key.pubkey).not.toBe(key.sourcePubkey)
    const result = inspect(response(), new Set([`${key.caip}:${key.pubkey}`]))
    expect(result.confirmed).toBe(false)
    expect(result.matches.has(key.pubkey)).toBe(false)
  })

  test('another network or owner cannot stand in for a missing BTC account', () => {
    const wrongNetwork = response().map((row, index) => index ? row : { ...row, caip: 'bip122:other/slip44:0' })
    const wrongOwner = response().map((row, index) => index ? row : { ...row, pubkey: 'xpub-other-owner' })
    expect(inspect(wrongNetwork).confirmed).toBe(false)
    expect(inspect(wrongOwner).confirmed).toBe(false)
  })

  test('missing, malformed, negative, nonfinite and explicitly untrusted rows stay unconfirmed', () => {
    for (const value of [undefined, null, '', ' ', 'NaN', 'Infinity', '-0.1', '0.1 garbage', '0x1', true]) {
      const rows = response().map((row, index) => index ? row : { ...row, balance: value })
      expect(inspect(rows).confirmed).toBe(false)
    }
    for (const patch of [{ valueUsd: NaN }, { valueUsd: Infinity }, { valueUsd: -1 }, { verified: false }, { degraded: true }, { isStale: true }, { syncState: 'stale' }]) {
      const rows = response().map((row, index) => index ? row : { ...row, ...patch })
      expect(inspect(rows).confirmed).toBe(false)
    }
  })

  test('a valid decimal amount is retained, including one satoshi', () => {
    const rows = response().map((row, index) => index ? row : { ...row, balance: '0.00000001', valueUsd: 0.001 })
    const result = inspect(rows)
    expect(result.confirmed).toBe(true)
    expect(result.matches.get(keys[0].pubkey).balance).toBe('0.00000001')
  })

  test('an incomplete response keeps a last confirmed balance instead of replacing it with zero', () => {
    const confirmed = { chainId: 'bitcoin', symbol: 'BTC', balance: '0.1', balanceUsd: 10000, address: 'saved-address', syncState: 'confirmed' as const }
    const partial = inspect(response().slice(1))
    const incoming = { ...confirmed, balance: '0', balanceUsd: 0, syncState: partial.confirmed ? 'confirmed' as const : 'degraded' as const }
    expect(mergeTrustedBalanceSnapshot(confirmed, incoming, false)?.balance).toBe('0.1')
    const complete = inspect(response())
    expect(mergeTrustedBalanceSnapshot(confirmed, { ...incoming, syncState: complete.confirmed ? 'confirmed' : 'degraded' }, false)?.balance).toBe('0')
  })
})
