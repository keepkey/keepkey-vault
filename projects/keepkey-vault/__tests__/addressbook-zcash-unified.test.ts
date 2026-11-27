/** KEEPKEY-180: the Address Book shows the wallet's own Zcash unified address (u1…), and only that wallet's.
 *  The sidecar keeps the last viewing key loaded in this process, so the cached u1 may belong to another seed or
 *  to a passphrase wallet: it is seeded only when its key is the one remembered for the current wallet. */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'vault-zcash-unified-'))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData: dir } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData: dir } }))
const db = await import('../src/bun/db')
const { exportOrchardFvk, rememberedOrchardFvk } = await import('../src/bun/txbuilder/zcash-shielded')
const { ownZcashUnifiedAddress, OWN_UNIFIED_LABEL } = await import('../src/bun/zcash-own-address')
const { isTransparentZcashRecipient } = await import('../src/mainview/lib/zcash-send-recipients')

beforeAll(() => db.initDb())
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

const ZEC = 'bip122:00040fe8ec8471911baa1db1266ea15d'
const UA_A = 'u1qqqqwalletaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const hex = (n: number) => Buffer.from([n, n, n]).toString('hex')

/** A device for one wallet identity (its ETH m/44'/60'/0'/0/0 address) whose Orchard ak starts with `n`. */
const device = (eth: string, n: number) => ({
  transport: { delegate: {} },
  ethGetAddress: async () => eth,
  zcashGetOrchardFVK: async () => ({ ak: new Uint8Array([n, n, n]), nk: new Uint8Array([2]), rivk: new Uint8Array([3]) }),
})

describe('rememberedOrchardFvk', () => {
  test("returns a wallet's key only after it was exported for that wallet, without asking the device", async () => {
    expect(rememberedOrchardFvk('0xA1')).toBeNull()
    await exportOrchardFvk(device('0xA1', 7), 0)
    expect(Buffer.from(rememberedOrchardFvk('0xa1')!.ak).toString('hex')).toBe(hex(7)) // identity is case-insensitive
    expect(rememberedOrchardFvk('0xB2')).toBeNull() // another seed or passphrase
    expect(rememberedOrchardFvk('0xA1', 1)).toBeNull() // another account
  })
})

describe('ownZcashUnifiedAddress', () => {
  const keyA = { ak: hex(7), nk: '02', rivk: '03' }
  const cachedA = { address: UA_A, fvk: keyA }
  test('seeds the cached u1 when its key is this wallet\'s', () => {
    expect(ownZcashUnifiedAddress({ cached: cachedA, remembered: { ak: new Uint8Array([7, 7, 7]), nk: new Uint8Array([2]), rivk: new Uint8Array([3]) }, networkId: ZEC })).toEqual({
      address: UA_A, networkId: ZEC, chainId: 'zcash-shielded', chainFamily: 'zcash-shielded',
      symbol: 'ZEC', label: OWN_UNIFIED_LABEL, derivationPath: "m/32'/133'/0'", addressIndex: 0,
    })
  })
  test('never seeds another wallet\'s, an unknown or a malformed address', () => {
    const remembered = { ak: new Uint8Array([7, 7, 7]), nk: new Uint8Array([2]), rivk: new Uint8Array([3]) }
    expect(ownZcashUnifiedAddress({ cached: cachedA, remembered: { ...remembered, ak: new Uint8Array([9, 9, 9]) }, networkId: ZEC })).toBeNull()
    // Same ak, another nk or rivk: another full viewing key, so another address.
    expect(ownZcashUnifiedAddress({ cached: cachedA, remembered: { ...remembered, nk: new Uint8Array([8]) }, networkId: ZEC })).toBeNull()
    expect(ownZcashUnifiedAddress({ cached: cachedA, remembered: { ...remembered, rivk: new Uint8Array([8]) }, networkId: ZEC })).toBeNull()
    expect(ownZcashUnifiedAddress({ cached: cachedA, remembered: { ak: remembered.ak }, networkId: ZEC })).toBeNull() // an incomplete key
    expect(ownZcashUnifiedAddress({ cached: cachedA, remembered: null, networkId: ZEC })).toBeNull()
    expect(ownZcashUnifiedAddress({ cached: null, remembered, networkId: ZEC })).toBeNull()
    expect(ownZcashUnifiedAddress({ cached: cachedA, remembered, networkId: undefined })).toBeNull()
    expect(ownZcashUnifiedAddress({ cached: { address: 't1ownTransparent', fvk: keyA }, remembered, networkId: ZEC })).toBeNull()
    expect(ownZcashUnifiedAddress({ cached: { address: 'utest1abc', fvk: keyA }, remembered, networkId: ZEC })).toBeNull()
  })
})

describe('Address Book rows across wallets', () => {
  const unifiedRows = (walletId: string) =>
    db.getAddressBookList({ walletId, kind: 'own' }).filter(e => e.chainId === 'zcash-shielded')

  test("wallet A gets its u1 once; a wallet switched to while the sidecar still holds A's key gets none", async () => {
    // Wallet A: its key is remembered and the sidecar holds it.
    await exportOrchardFvk(device('0xA1', 7), 0)
    const cached = { address: UA_A, fvk: { ak: hex(7), nk: '02', rivk: '03' } }
    const seedFor = (identity: string) =>
      ownZcashUnifiedAddress({ cached, remembered: rememberedOrchardFvk(identity), networkId: ZEC })

    const a = seedFor('0xA1')!
    db.syncOwnAddressBook({ deviceId: 'dev', walletId: 'dev:0xa1' }, [a])
    db.syncOwnAddressBook({ deviceId: 'dev', walletId: 'dev:0xa1' }, [a]) // the next refresh: no duplicate
    expect(unifiedRows('dev:0xa1').map(e => e.address)).toEqual([UA_A])

    // Same device, another seed or a passphrase wallet whose key was never exported: nothing to seed.
    expect(seedFor('0xB2')).toBeNull()
    // ...and once its own key is remembered, A's cached u1 still does not match it.
    await exportOrchardFvk(device('0xB2', 9), 0)
    expect(seedFor('0xB2')).toBeNull()

    db.syncOwnAddressBook({ deviceId: 'dev', walletId: 'dev:0xb2' }, [])
    expect(unifiedRows('dev:0xb2')).toEqual([])
    expect(unifiedRows('dev:0xa1').map(e => e.address)).toEqual([UA_A]) // A keeps its own
  })
})

test('the transparent ZEC Send picker never offers a unified address, own or not', () => {
  expect(isTransparentZcashRecipient(UA_A)).toBe(false)
  expect(isTransparentZcashRecipient(' u1abc ')).toBe(false)
  expect(isTransparentZcashRecipient('t1ownTransparent')).toBe(true)
  expect(isTransparentZcashRecipient('t3script')).toBe(true)
  expect(isTransparentZcashRecipient('tex1abc')).toBe(true)
})
