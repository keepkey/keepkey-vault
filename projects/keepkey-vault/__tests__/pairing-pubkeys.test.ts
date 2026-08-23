/**
 * Mobile-pairing payload: the paired phone must see every account the desktop
 * knows about, not just account 0 (keepkey/keepkey-vault#406).
 */
import { describe, test, expect } from 'bun:test'
import { btcPairingEntries, utxoPairingEntries, evmPairingEntries } from '../src/bun/pairing-pubkeys'

const CONTEXT = 'keepkey:test.json'
const BTC_NET = 'bip122:000000000019d6689c085ae165831e93'

const btcMeta = (accountIndex: number, scriptType: any, purpose: number, xpub: string) => ({
  xpub, scriptType, accountIndex, path: [purpose + 0x80000000, 0x80000000, accountIndex + 0x80000000],
})

describe('btcPairingEntries', () => {
  test('emits one entry per account × script type, with the account in the path', () => {
    const entries = btcPairingEntries([
      btcMeta(0, 'p2wpkh', 84, 'zpub-acct0'),
      btcMeta(1, 'p2wpkh', 84, 'zpub-acct1'),
    ], BTC_NET, CONTEXT)

    expect(entries.map(e => e.path)).toEqual(["m/84'/0'/0'", "m/84'/0'/1'"])
    expect(entries.map(e => e.pathMaster)).toEqual(["m/84'/0'/0'/0/0", "m/84'/0'/1'/0/0"])
    expect(entries[1].addressNList).toEqual([0x80000054, 0x80000000, 0x80000001])
    expect(entries[1].note).toContain('account 1')
    // xpub-prefixed `type` and the SDK's `address` alias are part of the payload contract
    expect(entries[0].type).toBe('zpub')
    expect(entries[0].address).toBe('zpub-acct0')
    expect(entries[0].networks).toEqual([BTC_NET])
  })

  test('available_scripts_types covers every derived script type', () => {
    const entries = btcPairingEntries([
      btcMeta(0, 'p2pkh', 44, 'xpub0'),
      btcMeta(0, 'p2wpkh', 84, 'zpub0'),
      btcMeta(1, 'p2wpkh', 84, 'zpub1'),
    ], BTC_NET, CONTEXT)
    expect(entries[0].available_scripts_types).toEqual(['p2pkh', 'p2wpkh', 'p2sh'])
  })

  test('drops empty xpubs', () => {
    expect(btcPairingEntries([btcMeta(0, 'p2wpkh', 84, '')], BTC_NET, CONTEXT)).toEqual([])
  })
})

describe('utxoPairingEntries', () => {
  const chains = [{ id: 'litecoin', symbol: 'LTC', networkId: 'bip122:ltc', scriptType: 'p2wpkh' }]

  test('keeps tracked accounts > 0 and dedups the account-0 xpub', () => {
    const entries = utxoPairingEntries([
      { chainId: 'litecoin', xpub: 'zpub-ltc0', scriptType: 'p2wpkh', path: [0x80000054, 0x80000002, 0x80000000] },
      { chainId: 'litecoin', xpub: 'zpub-ltc0', scriptType: 'p2wpkh', path: [0x80000054, 0x80000002, 0x80000000] },
      { chainId: 'litecoin', xpub: 'zpub-ltc1', scriptType: 'p2wpkh', path: [0x80000054, 0x80000002, 0x80000001] },
    ], chains, CONTEXT)

    expect(entries.map(e => e.pubkey)).toEqual(['zpub-ltc0', 'zpub-ltc1'])
    expect(entries[1].pathMaster).toBe("m/84'/2'/1'/0/0")
    expect(entries[1].note).toContain('account 1')
  })

  test('ignores rows for chains not in the pairing set', () => {
    const entries = utxoPairingEntries(
      [{ chainId: 'dogecoin', xpub: 'dgub', path: [0x8000002C, 0x80000003, 0x80000000] }],
      chains, CONTEXT,
    )
    expect(entries).toEqual([])
  })
})

describe('evmPairingEntries', () => {
  test('emits one entry per tracked index at the account-hardened path', () => {
    const entries = evmPairingEntries(
      [{ address: '0xaaa', addressIndex: 0 }, { address: '0xbbb', addressIndex: 2 }],
      ['eip155:1', 'eip155:*'], CONTEXT,
    )
    expect(entries.map(e => e.pathMaster)).toEqual(["m/44'/60'/0'/0/0", "m/44'/60'/2'/0/0"])
    expect(entries[1].addressNList).toEqual([0x8000002C, 0x8000003C, 0x80000002])
    expect(entries[1].networks).toEqual(['eip155:1', 'eip155:*'])
    expect(entries[0].note).toBe('ETH primary (default)')
  })

  test('dedups the same address case-insensitively', () => {
    const entries = evmPairingEntries(
      [{ address: '0xAbC', addressIndex: 0 }, { address: '0xabc', addressIndex: 0 }],
      ['eip155:1'], CONTEXT,
    )
    expect(entries).toHaveLength(1)
  })
})
