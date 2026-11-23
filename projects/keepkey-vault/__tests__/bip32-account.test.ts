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
const { MAX_ACCOUNT_INDEX, MAX_PATH_ELEMENT, assertAccountIndex, hardenedAccount, isAccountIndex, isPathElement, parseBip32PathStrict } = await import('../src/shared/bip32-account')
const S = await import('../src/bun/schemas')
const { CHAINS, btcAccountPath, evmAddressPath, hiveRolePath, zcashTransparentReceivePath } = await import('../src/shared/chains')
const { ephemeralPath } = await import('../src/bun/txbuilder/zcash-tex')
const { EVM_KNOWN_SCHEMES } = await import('../src/shared/evm-paths')
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

describe('raw paths sent by a client must fit in 32 bits unsigned', () => {
  test('path element and strict path parser', () => {
    expect(MAX_PATH_ELEMENT).toBe(2 ** 32 - 1)
    for (const value of [0, 2 ** 31, MAX_PATH_ELEMENT]) expect(isPathElement(value)).toBe(true)
    for (const value of [-1, 2 ** 32, 1.5, Number.NaN, '0']) expect(isPathElement(value)).toBe(false)
    expect(parseBip32PathStrict("m/84'/0'/2'/1/7")).toEqual([0x80000054, 0x80000000, 0x80000002, 1, 7])
    expect(parseBip32PathStrict('m/44h/133H/0h/0/0')).toEqual([0x8000002C, 0x80000085, 0x80000000, 0, 0])
    // Before, a balance-server path like these became NaN or wrapped to another index.
    for (const bad of ["m/84'/0'/4294967296'/0/0", "m/84'/0'/0'/0/2147483648", "m/84'/0'/x'/0/0", "m/84'/0'//0", "m/84'/0'/-1'/0/0", ''])
      expect(() => parseBip32PathStrict(bad)).toThrow('Unreadable derivation path')
  })
  test('every REST schema field that takes a path refuses negative and 2^32+ elements', () => {
    const fields: string[] = []
    for (const [name, schema] of Object.entries(S) as Array<[string, any]>) {
      const shape = schema?.shape
      if (!shape) continue
      for (const key of ['address_n', 'addressNList', 'address_n_list']) {
        if (!shape[key]) continue
        fields.push(`${name}.${key}`)
        const field = shape[key]
        expect(field.safeParse([0x8000002C, 0x80000000, MAX_PATH_ELEMENT]).success).toBe(true)
        for (const bad of [-1, 2 ** 32, 2 ** 32 + 0x8000002C]) expect(field.safeParse([0x8000002C, 0x80000000, bad]).success).toBe(false)
      }
    }
    // Guards against the sweep silently finding nothing; nested fields are checked explicitly below.
    expect(fields.length).toBeGreaterThanOrEqual(20)
    const sign = (entry: Record<string, unknown>) => S.UtxoSignTransactionRequest.safeParse({ coin: 'Bitcoin', inputs: [entry], outputs: [{ address: 'x', amount: '1' }] })
    const signChange = (entry: Record<string, unknown>) => S.UtxoSignTransactionRequest.safeParse({ coin: 'Bitcoin', inputs: [{ txid: 'a' }], outputs: [entry] })
    expect(sign({ txid: 'a', vout: 0, addressNList: [0x80000054, 0x80000000, 0x80000000, 0, MAX_PATH_ELEMENT] }).success).toBe(true)
    for (const key of ['addressNList', 'address_n']) {
      expect(sign({ txid: 'a', [key]: [0x80000054, 0x80000000, 2 ** 32 + 0x80000005, 0, 0] }).success).toBe(false)
      expect(sign({ txid: 'a', [key]: [0x80000054, -1] }).success).toBe(false)
      expect(signChange({ isChange: true, [key]: [0x80000054, 0x80000000, 2 ** 32, 1, 0] }).success).toBe(false)
    }
    // Other input fields still reach the signer unchanged.
    const parsed = sign({ txid: 'a', vout: 1, amount: '100', scriptType: 'p2wpkh', hex: '00' })
    expect(parsed.success && parsed.data.inputs[0]).toEqual({ txid: 'a', vout: 1, amount: '100', scriptType: 'p2wpkh', hex: '00' })
    const batch = (address_n: number[]) => S.BatchPubkeysRequest.safeParse({ paths: [{ address_n }] })
    expect(batch([0x8000002C, 0x80000000, 2 ** 32]).success).toBe(false)
    expect(batch([0x8000002C, 0x80000000, -1]).success).toBe(false)
  })
})

describe('the remaining account path builders refuse instead of wrapping', () => {
  test('Zcash transparent receive path (balance RPC)', () => {
    expect(zcashTransparentReceivePath(0)).toEqual([0x8000002C, 0x80000085, 0x80000000, 0, 0])
    expect(() => zcashTransparentReceivePath(2 ** 32)).toThrow(RangeError)
  })
  test('Zcash TEX one-time address path', () => {
    expect(ephemeralPath(0, 3)).toEqual([0x8000002C, 0x80000085, 0x80000000, 2, 3])
    expect(() => ephemeralPath(2 ** 32, 0)).toThrow(RangeError)
    expect(() => ephemeralPath(0, 2 ** 31)).toThrow('Ephemeral address index')
  })
  test('EVM known-path grid schemes', () => {
    let checked = 0
    for (const scheme of EVM_KNOWN_SCHEMES) {
      if (!scheme.template.includes("i'")) continue
      checked++
      expect(scheme.path(MAX_ACCOUNT_INDEX)).toContain(0xffffffff)
      expect(() => scheme.path(2 ** 32)).toThrow(RangeError)
    }
    expect(checked).toBe(2)
  })
})
