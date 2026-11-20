/** Audit v6 H8: an account index from 2^31 up overflows the hardened path element and wraps to another account. */
import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// zcash-shielded reaches the app database, which needs the desktop runtime's paths.
const userData = mkdtempSync(join(tmpdir(), 'vault-bip32-account-'))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData } }))
mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const { MAX_ACCOUNT_INDEX, assertAccountIndex, hardenedAccount, isAccountIndex } = await import('../src/shared/bip32-account')
const S = await import('../src/bun/schemas')
const { CHAINS, btcAccountPath, evmAddressPath, hiveRolePath } = await import('../src/shared/chains')
const { chainLevelPath, utxoAccountScriptPaths } = await import('../src/bun/chain-scan')
const { displayOrchardAddressOnDevice, exportOrchardFvk } = await import('../src/bun/txbuilder/zcash-shielded')
const { EvmAddressManager } = await import('../src/bun/evm-addresses')
const { getSetting, initDb, setSetting } = await import('../src/bun/db')
initDb()
const { watchOnlyPortfolioKeys, trackedUtxoScriptPaths } = await import('../src/bun/watch-only-portfolio')
const { pathToBip32 } = await import('../src/bun/chain-scan')

const TOO_LARGE = [2 ** 31, 2 ** 32, 2 ** 32 + 7, Number.MAX_SAFE_INTEGER]
const NOT_INDEXES = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined]
const chain = (id: string) => CHAINS.find(entry => entry.id === id)!

describe('the hardened account helper', () => {
  test('accepts 0 to 2^31 - 1 and builds 2^31 + index', () => {
    expect(MAX_ACCOUNT_INDEX).toBe(2 ** 31 - 1)
    expect([0, 1, MAX_ACCOUNT_INDEX].map(index => hardenedAccount(index))).toEqual([0x80000000, 0x80000001, 0xffffffff])
    expect(isAccountIndex(MAX_ACCOUNT_INDEX)).toBe(true)
  })
  test('refuses anything that would wrap or is not an index, instead of producing another account', () => {
    for (const value of [...TOO_LARGE, ...NOT_INDEXES]) {
      expect(isAccountIndex(value)).toBe(false)
      expect(() => assertAccountIndex(value)).toThrow(`from 0 to ${MAX_ACCOUNT_INDEX}`)
    }
    expect(() => hardenedAccount(2 ** 32, 'EVM address index')).toThrow('EVM address index must be an integer')
  })
})

describe('every API that names an account caps it at 2^31 - 1', () => {
  const schemas: Array<[string, any, (index: number) => unknown]> = [
    ['POST /api/v2/tx/build accountIndex', S.TxBuildRequest, accountIndex => ({ caip: 'bip122:000000000019d6689c085ae165831e93/slip44:0', to: 'x', amount: '1', accountIndex })],
    ['POST /api/zcash/shielded/init account', S.ZcashInitRequest, account => ({ account })],
    ['POST /api/zcash/shielded/display-address account', S.ZcashDisplayAddressRequest, account => ({ account })],
    ['POST /api/zcash/shielded/build account', S.ZcashBuildRequest, account => ({ recipient: 'u1', amount: 1, account })],
  ]
  for (const [name, schema, body] of schemas) test(name, () => {
    expect(schema.safeParse(body(MAX_ACCOUNT_INDEX)).success).toBe(true)
    for (const index of [...TOO_LARGE, -1, 1.5]) expect(schema.safeParse(body(index)).success).toBe(false)
  })
})

describe('paths are never built from an out-of-range index, even if a caller skips validation', () => {
  test('UTXO account paths', () => {
    expect(utxoAccountScriptPaths(chain('bitcoin'), MAX_ACCOUNT_INDEX).every(entry => entry.path[2] === 0xffffffff)).toBe(true)
    for (const account of TOO_LARGE) expect(() => utxoAccountScriptPaths(chain('bitcoin'), account)).toThrow(RangeError)
    expect(() => utxoAccountScriptPaths(chain('litecoin'), 2 ** 32)).toThrow(RangeError)
  })
  test('account-level and EVM address paths', () => {
    expect(chainLevelPath(chain('litecoin'), 3)[2]).toBe(0x80000003)
    expect(() => chainLevelPath(chain('litecoin'), 2 ** 32)).toThrow(RangeError)
    expect(evmAddressPath(5)).toEqual([0x8000002C, 0x8000003C, 0x80000005, 0, 0])
    expect(() => evmAddressPath(2 ** 32)).toThrow('EVM address index')
  })
  test('Bitcoin account and Hive role paths', () => {
    expect(btcAccountPath(84, MAX_ACCOUNT_INDEX)).toEqual([0x80000054, 0x80000000, 0xffffffff])
    expect(() => btcAccountPath(84, 2 ** 32)).toThrow(RangeError)
    expect(hiveRolePath('active', 2)).toEqual([0x80000030, 0x8000000D, 0x80000001, 0x80000002, 0x80000000])
    expect(() => hiveRolePath('active', 2 ** 32)).toThrow(RangeError)
  })
  test('Zcash shielded: nothing reaches the device', async () => {
    const calls: string[] = []
    const wallet = { zcashDisplayAddress: async () => { calls.push('display'); return { address: 'u1' } }, zcashGetOrchardFVK: async () => { calls.push('fvk'); return {} } }
    await expect(displayOrchardAddressOnDevice(wallet, 2 ** 32)).rejects.toThrow(RangeError)
    await expect(exportOrchardFvk(wallet, 2 ** 32)).rejects.toThrow(RangeError)
    expect(calls).toEqual([])
  })
})

describe('saved data with an out-of-range index is skipped, not allowed to break every account', () => {
  test('EVM: a saved address index from 2^31 up is dropped and the others still load', async () => {
    setSetting('evm_tracked_indices_version', '2')
    setSetting('evm_tracked_indices', JSON.stringify([0, 2 ** 32, 1, 2 ** 31]))
    const asked: number[] = []
    const wallet = { ethGetAddress: async ({ addressNList }: { addressNList: number[] }) => { asked.push(addressNList[2]); return `0x${addressNList[2].toString(16)}` } }
    const set = await new EvmAddressManager().initialize(wallet)
    expect(set.addresses.map((entry: any) => entry.addressIndex)).toEqual([0, 1])
    expect(asked).toEqual([0x80000000, 0x80000001])
    expect(JSON.parse(getSetting('evm_tracked_indices')!)).toEqual([0, 1])
  })
  test('watch-only UTXO: a cached row ending in an account from 2^31 up does not stop the key list', () => {
    const ltc = chain('litecoin')
    const good = utxoAccountScriptPaths(ltc, 0).map(sp => ({ chainId: ltc.id, xpub: `xpub-${sp.scriptType}`, path: pathToBip32(sp.path), scriptType: sp.scriptType, address: '' }))
    const bad = { chainId: ltc.id, xpub: 'xpub-bad', path: "m/44'/2'/4294967296'", scriptType: 'p2pkh', address: '' }
    // Before, utxoAccountScriptPaths threw here and no chain got a key list.
    const { pubkeys } = watchOnlyPortfolioKeys([ltc], [], [...good, bad] as any)
    expect(pubkeys.map(key => key.sourcePubkey)).toEqual(expect.arrayContaining(good.map(row => row.xpub)))
    expect(trackedUtxoScriptPaths(ltc, [...good, bad] as any).every(entry => entry.path[2] === 0x80000000)).toBe(true)
  })
})
