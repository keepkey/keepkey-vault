/**
 * chain-scan pure-helper tests — the family-aware derivation + parsing the
 * per-chain Audit walkthrough relies on. Imports ONLY src/bun/chain-scan
 * (pure; reads ../shared/chains) — no db/device, safe under bun test.
 *
 * Run: bun test __tests__/chain-scan.test.ts
 */
import { describe, test, expect } from 'bun:test'
import {
  chainLevelPath, deriveAddressParams, extractAddress, parseNativeBalance, parseEvmScanResult,
  explorerAddressUrl, pathToBip32, parseBip32Path, chainSupportsDeepScan, chainSupportsLevelScan,
} from '../src/bun/chain-scan'
import { EVM_KNOWN_SCHEMES } from '../src/shared/evm-paths'
import type { ChainDef } from '../src/shared/chains'

// Minimal ChainDef fixtures (only the fields the helpers read).
const ETH = { id: 'ethereum', symbol: 'ETH', coin: 'Ethereum', chainFamily: 'evm', rpcMethod: 'ethGetAddress', networkId: 'eip155:1', defaultPath: [0x8000002C, 0x8000003C, 0x80000000, 0, 0], explorerAddressUrl: 'https://etherscan.io/address/{{address}}' } as ChainDef
const ATOM = { id: 'cosmos', symbol: 'ATOM', coin: 'Cosmos', chainFamily: 'cosmos', rpcMethod: 'cosmosGetAddress', networkId: 'cosmos:cosmoshub-4', defaultPath: [0x8000002C, 0x80000076, 0x80000000, 0, 0] } as ChainDef
const XRP = { id: 'ripple', symbol: 'XRP', coin: 'Ripple', chainFamily: 'xrp', rpcMethod: 'xrpGetAddress', networkId: 'ripple:0', defaultPath: [0x8000002C, 0x80000090, 0x80000000, 0, 0] } as ChainDef
const TON = { id: 'ton', symbol: 'TON', coin: 'Ton', chainFamily: 'ton', rpcMethod: 'tonGetAddress', networkId: 'ton:0', defaultPath: [0x8000002C, 0x8000025F, 0x80000000] } as ChainDef
const BTC = { id: 'bitcoin', symbol: 'BTC', coin: 'Bitcoin', chainFamily: 'utxo', rpcMethod: 'btcGetAddress', networkId: 'bip122:x', defaultPath: [0x80000054, 0x80000000, 0x80000000, 0, 0], scriptType: 'p2wpkh' } as ChainDef
const ZEC_SHIELDED = { id: 'zcash-shielded', symbol: 'ZEC', coin: 'Zcash', chainFamily: 'zcash-shielded', rpcMethod: 'zcashGetOrchardFvk', networkId: 'x', defaultPath: [] } as ChainDef
const HIVE = { id: 'hive', symbol: 'HIVE', coin: 'Hive', chainFamily: 'hive', rpcMethod: 'hiveGetPublicKey', networkId: 'x', defaultPath: [0x8000002C, 0x800004FB, 0x80000000, 0, 0] } as ChainDef

describe('chainLevelPath — family-aware', () => {
  test('EVM uses evmAddressPath — the shared EVM key at index [2] (matches addEvmAddressIndex)', () => {
    expect(chainLevelPath(ETH, 5)).toEqual([0x8000002C, 0x8000003C, 0x80000000 + 5, 0, 0])
  })
  test('non-EVM bumps the BIP44 account element [2]', () => {
    expect(chainLevelPath(ATOM, 3)).toEqual([0x8000002C, 0x80000076, 0x80000000 + 3, 0, 0])
  })
  test('account bump is hardened (0x80000000 + N)', () => {
    expect(chainLevelPath(ATOM, 3)[2]).toBe(0x80000000 + 3)
    expect(chainLevelPath(BTC, 2)[2]).toBe(0x80000000 + 2)
  })
  test('level 0 returns the default path', () => {
    expect(chainLevelPath(ATOM, 0)).toEqual(ATOM.defaultPath)
    expect(chainLevelPath(ETH, 0)).toEqual(ETH.defaultPath)
  })
})

describe('deriveAddressParams — method + quirks', () => {
  test('XRP uses rippleGetAddress, not the schema rpcMethod', () => {
    expect(deriveAddressParams(XRP, XRP.defaultPath).method).toBe('rippleGetAddress')
  })
  test('other chains use rpcMethod verbatim', () => {
    expect(deriveAddressParams(ETH, ETH.defaultPath).method).toBe('ethGetAddress')
    expect(deriveAddressParams(ATOM, ATOM.defaultPath).method).toBe('cosmosGetAddress')
  })
  test('BTC includes scriptType', () => {
    expect(deriveAddressParams(BTC, BTC.defaultPath).params.scriptType).toBe('p2wpkh')
  })
  test('TON sets bounceable=false', () => {
    expect(deriveAddressParams(TON, TON.defaultPath).params.bounceable).toBe(false)
  })
  test('non-BTC has no scriptType', () => {
    expect(deriveAddressParams(ETH, ETH.defaultPath).params.scriptType).toBeUndefined()
  })
})

describe('extractAddress', () => {
  test('handles string, .address, .publicKey', () => {
    expect(extractAddress('addr1')).toBe('addr1')
    expect(extractAddress({ address: 'addr2' })).toBe('addr2')
    expect(extractAddress({ publicKey: 'pk3' })).toBe('pk3')
    expect(extractAddress(null)).toBe('')
  })
})

describe('parseNativeBalance', () => {
  test('reads nativeBalance then balance, detects funded', () => {
    expect(parseNativeBalance({ data: { nativeBalance: '1.5' } })).toEqual({ native: '1.5', hasBalance: true })
    expect(parseNativeBalance({ data: { balance: '0' } })).toEqual({ native: '0', hasBalance: false })
    expect(parseNativeBalance({ nativeBalance: '2' })).toEqual({ native: '2', hasBalance: true })
    expect(parseNativeBalance({})).toEqual({ native: '0', hasBalance: false })
  })
})

describe('parseEvmScanResult — native + tokens classifier (takes unwrapped entries)', () => {
  const native = (bal: string) => ({ caip: 'eip155:1/slip44:60', balance: bal, valueUsd: 1 })
  const token = (sym: string, bal: string, usd: number, contract = '0xabc') =>
    ({ caip: `eip155:1/erc20:${contract}`, symbol: sym, name: sym, balance: bal, valueUsd: usd })

  test('separates native from tokens; funded when native > 0', () => {
    const r = parseEvmScanResult([native('1.5'), token('USDC', '500', 500)])
    expect(r.native).toBe('1.5')
    expect(r.hasBalance).toBe(true)
    expect(r.tokens).toEqual([{ symbol: 'USDC', name: 'USDC', balance: '500', balanceUsd: 500, caip: 'eip155:1/erc20:0xabc' }])
  })
  test('token-only account (0 native, funded token) is funded — never a false empty', () => {
    const r = parseEvmScanResult([native('0'), token('USDT', '250', 250)])
    expect(r.native).toBe('0')
    expect(r.hasBalance).toBe(true)
    expect(r.tokens.length).toBe(1)
  })
  test('truly empty → hasBalance false, no tokens (caller maps degraded → balanceError)', () => {
    const r = parseEvmScanResult([native('0')])
    expect(r.hasBalance).toBe(false)
    expect(r.tokens).toEqual([])
  })
  test('drops zero-balance tokens', () => {
    const r = parseEvmScanResult([native('0'), token('SPAM', '0', 0)])
    expect(r.hasBalance).toBe(false)
    expect(r.tokens).toEqual([])
  })
  test('empty/non-array entries → empty, never throws', () => {
    expect(parseEvmScanResult([]).hasBalance).toBe(false)
    expect(parseEvmScanResult(undefined as any).hasBalance).toBe(false)
  })
  test('classifies native by slip44/native asset part, token otherwise', () => {
    expect(parseEvmScanResult([{ caip: 'eip155:42161/slip44:60', balance: '0.2' }]).native).toBe('0.2')
    expect(parseEvmScanResult([{ caip: 'eip155:1/native:eth', balance: '0.3' }]).native).toBe('0.3')
    // type:'token' flag classifies a contract entry even without an erc20 caip
    const r = parseEvmScanResult([{ caip: 'eip155:1/slip44:60', balance: '0' }, { type: 'token', symbol: 'X', balance: '5', valueUsd: 9, caip: 'eip155:1/foo:bar' }])
    expect(r.tokens.length).toBe(1)
    expect(r.native).toBe('0')
  })
})

describe('explorerAddressUrl', () => {
  test('substitutes {{address}}; null when no template/address', () => {
    expect(explorerAddressUrl(ETH, '0xabc')).toBe('https://etherscan.io/address/0xabc')
    expect(explorerAddressUrl(ATOM, 'cosmos1xyz')).toBeNull() // no template
    expect(explorerAddressUrl(ETH, '')).toBeNull()
  })
})

describe('parseBip32Path', () => {
  test('parses hardened (apostrophe or h) and non-hardened', () => {
    expect(parseBip32Path("m/44'/60'/0'/0/5")).toEqual([0x8000002C, 0x8000003C, 0x80000000, 0, 5])
    expect(parseBip32Path("44h/60h/0h/0/5")).toEqual([0x8000002C, 0x8000003C, 0x80000000, 0, 5])
  })
  test('rejects malformed / out-of-range / too short / too long', () => {
    expect(parseBip32Path('not a path')).toBeNull()
    expect(parseBip32Path('m/44/')).toBeNull()
    expect(parseBip32Path("m/44'")).toBeNull() // length 1
    expect(parseBip32Path("m/" + Array(11).fill("0").join('/'))).toBeNull() // length 11
    expect(parseBip32Path("m/2147483648/0")).toBeNull() // >= 0x80000000 before hardening
  })
})

describe('pathToBip32', () => {
  test('round-trips a path to string form', () => {
    expect(pathToBip32([0x8000002C, 0x8000003C, 0x80000000, 0, 5])).toBe("m/44'/60'/0'/0/5")
  })
})

describe('chainSupportsDeepScan (custom paths)', () => {
  test('excludes zcash-shielded and hive, allows the rest including BTC', () => {
    expect(chainSupportsDeepScan(ZEC_SHIELDED)).toBe(false)
    expect(chainSupportsDeepScan(HIVE)).toBe(false)
    expect(chainSupportsDeepScan(ETH)).toBe(true)
    expect(chainSupportsDeepScan(ATOM)).toBe(true)
    expect(chainSupportsDeepScan(BTC)).toBe(true) // custom paths (with scriptType) are valid for BTC
  })
})

describe('EVM_KNOWN_SCHEMES (MyEtherWallet-style grid)', () => {
  const H = 0x80000000
  test('BIP44/MetaMask varies the LAST element (receive index)', () => {
    const s = EVM_KNOWN_SCHEMES.find(x => x.key === 'bip44')!
    expect(s.path(0)).toEqual([H + 44, H + 60, H + 0, 0, 0])
    expect(s.path(3)).toEqual([H + 44, H + 60, H + 0, 0, 3])
  })
  test('Ledger Live varies the account element [2]', () => {
    const s = EVM_KNOWN_SCHEMES.find(x => x.key === 'ledger-live')!
    expect(s.path(2)).toEqual([H + 44, H + 60, H + 2, 0, 0])
  })
  test('Ledger Legacy/MEW is the 4-element m/44\'/60\'/0\'/i', () => {
    const s = EVM_KNOWN_SCHEMES.find(x => x.key === 'ledger-legacy')!
    expect(s.path(5)).toEqual([H + 44, H + 60, H + 0, 5])
  })
  test('every scheme yields a valid 2-10 element non-negative path at indices 0..3', () => {
    for (const s of EVM_KNOWN_SCHEMES) {
      for (let i = 0; i <= 3; i++) {
        const p = s.path(i)
        expect(p.length).toBeGreaterThanOrEqual(2)
        expect(p.length).toBeLessThanOrEqual(10)
        expect(p.every(n => Number.isInteger(n) && n >= 0)).toBe(true)
      }
    }
  })
  test('scheme keys are unique', () => {
    const keys = EVM_KNOWN_SCHEMES.map(s => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('chainSupportsLevelScan (per-account single-address scan)', () => {
  test('ALSO excludes UTXO — single-address scan would misread a funded account tree as empty', () => {
    expect(chainSupportsLevelScan(BTC)).toBe(false)
    expect(chainSupportsLevelScan(ZEC_SHIELDED)).toBe(false)
    expect(chainSupportsLevelScan(HIVE)).toBe(false)
    expect(chainSupportsLevelScan(ETH)).toBe(true)
    expect(chainSupportsLevelScan(ATOM)).toBe(true)
    expect(chainSupportsLevelScan(XRP)).toBe(true)
  })
})
