import { describe, expect, test } from 'bun:test'
import { addressToScriptPubKeyHex } from '../src/bun/txbuilder/utxo'
import { BtcAccountManager } from '../src/bun/btc-accounts'
import { btcTaprootSupported, supportedBtcScriptTypes } from '../src/shared/chains'
import { generatePathMatrix } from '../src/bun/sweep-engine'
import { ListUnspentRequest, PortfolioBalancesRequest, TxHistoryRequest } from '../src/bun/schemas'

const BIP350_P2TR = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'
const BIP350_P2TR_SCRIPT = '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const BIP350_WRONG_CHECKSUM = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd'

describe('BIP350 address decoding', () => {
  test('valid Bech32m P2TR becomes the exact v1 witness scriptPubKey', () => {
    expect(addressToScriptPubKeyHex(BIP350_P2TR)).toBe(BIP350_P2TR_SCRIPT)
  })

  test('v1 encoded with the old Bech32 checksum is rejected', () => {
    expect(addressToScriptPubKeyHex(BIP350_WRONG_CHECKSUM)).toBeUndefined()
  })
})

describe('firmware capability gate', () => {
  const wallet = (supportsTaproot?: boolean) => ({
    ...(supportsTaproot === undefined ? {} : {
      btcSupportsScriptType: async (coin: string, scriptType: string) =>
        coin === 'Bitcoin' && scriptType === 'p2tr' && supportsTaproot,
    }),
    getPublicKeys: async (paths: any[]) => paths.map((p, i) => ({ xpub: `xpub-${p.scriptType}-${i}` })),
  })

  test('missing/false capability keeps the historical three accounts', async () => {
    expect(await btcTaprootSupported(wallet())).toBe(false)
    expect((await supportedBtcScriptTypes(wallet(false))).map(x => x.scriptType))
      .toEqual(['p2pkh', 'p2sh-p2wpkh', 'p2wpkh'])

    const manager = new BtcAccountManager()
    await manager.initialize(wallet(false))
    expect(manager.toAccountSet().accounts[0].xpubs.map(x => x.scriptType))
      .toEqual(['p2pkh', 'p2sh-p2wpkh', 'p2wpkh'])
  })

  test('true capability adds BIP86 without changing the default selection', async () => {
    const manager = new BtcAccountManager()
    await manager.initialize(wallet(true))
    const set = manager.toAccountSet()
    expect(set.accounts[0].xpubs.map(x => [x.scriptType, x.purpose, x.path[0]]))
      .toEqual([
        ['p2pkh', 44, 0x8000002c],
        ['p2sh-p2wpkh', 49, 0x80000031],
        ['p2wpkh', 84, 0x80000054],
        ['p2tr', 86, 0x80000056],
      ])
    expect(set.selectedXpub).toEqual({ accountIndex: 0, scriptType: 'p2wpkh' })
  })
})

describe('Taproot discovery consumers', () => {
  test('recovery scan excludes P2TR by default and includes it only when gated on', () => {
    expect(generatePathMatrix({ accountRange: [0, 0] }).some(p => p.scriptType === 'p2tr')).toBe(false)
    const enabled = generatePathMatrix({ accountRange: [0, 0], includeTaproot: true })
    expect(enabled.some(p => p.path[0] === 0x80000056 && p.scriptType === 'p2tr')).toBe(true)
  })

  test('REST data contracts carry explicit P2TR intent beside the ordinary xpub', () => {
    expect(ListUnspentRequest.parse({ network: 'bitcoin', xpub: 'xpub-test', scriptType: 'p2tr' }).scriptType)
      .toBe('p2tr')
    expect(PortfolioBalancesRequest.parse({
      pubkeys: [{ caip: 'bip122:bitcoin/slip44:0', pubkey: 'xpub-test', scriptType: 'p2tr' }],
    }).pubkeys[0].scriptType).toBe('p2tr')
    expect(TxHistoryRequest.parse({
      queries: [{ caip: 'bip122:bitcoin/slip44:0', pubkey: 'xpub-test', scriptType: 'p2tr' }],
    }).queries[0].scriptType).toBe('p2tr')
  })
})
