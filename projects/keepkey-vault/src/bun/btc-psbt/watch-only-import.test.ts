import { describe, expect, it } from 'bun:test'
import { createHash } from 'crypto'
import { HDKey } from '@scure/bip32'
import { hex } from '@scure/base'
import { mnemonicToSeedSync } from 'bip39'
import { parseWatchOnlyImport, watchOnlyImportId } from './watch-only-import'
import { toSlip132, writeElectrumWallet } from './codec'
import { deriveAddress } from './psbt'

// Public BIP-39 test mnemonic; its BIP84 zpub and first address are the BIP84 test vectors.
const MASTER = HDKey.fromMasterSeed(new Uint8Array(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')))
const ZPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs'
const XPUB84 = MASTER.derive("m/84'/0'/0'").publicExtendedKey
const XPUB44 = MASTER.derive("m/44'/0'/0'").publicExtendedKey
const H = 0x80000000
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('bare key import', () => {
  it('reads a zpub with the assumed BIP84 path and no fingerprint', () => {
    const w = parseWatchOnlyImport(`  ${ZPUB}\n`)
    expect(w).toEqual({
      id: 'wo:' + sha(XPUB84), source: 'key', scriptType: 'p2wpkh', xpub: XPUB84, key: ZPUB,
      path: [84 + H, H, H], pathAssumed: true, fingerprint: null,
    })
    expect(parseWatchOnlyImport(ZPUB, { path: "m/84h/0h/0h" }).path).toEqual([84 + H, H, H])
  })

  it('takes account and script type from the key; Taproot requires an explicitly confirmed BIP86 path', () => {
    const acct2 = toSlip132(MASTER.derive("m/49'/0'/2'").publicExtendedKey, 'p2sh-p2wpkh')
    expect(parseWatchOnlyImport(acct2)).toMatchObject({ scriptType: 'p2sh-p2wpkh', path: [49 + H, H, 2 + H], pathAssumed: true })
    expect(parseWatchOnlyImport(XPUB44)).toMatchObject({ scriptType: 'p2pkh', path: [44 + H, H, H], key: XPUB44 })
    const xpub86 = MASTER.derive("m/86'/0'/0'").publicExtendedKey
    const taproot = parseWatchOnlyImport(xpub86, { path: "m/86'/0'/0'" })
    expect(taproot).toMatchObject({ scriptType: 'p2tr', path: [86 + H, H, H], key: xpub86 })
    expect(deriveAddress(taproot, 0, 0)).toBe('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr')
    expect(() => parseWatchOnlyImport(ZPUB, { path: "m/49'/0'/0'" })).toThrow(/can only be m\/84'\/0'\/0'/)
    expect(() => parseWatchOnlyImport(ZPUB, { path: "m/84'/0'/1'" })).toThrow(/can only be/)
  })

  it('accepts an entered fingerprint; zero means unknown', () => {
    expect(parseWatchOnlyImport(ZPUB, { fingerprint: '73C5DA0A' }).fingerprint).toBe('73c5da0a')
    expect(parseWatchOnlyImport(ZPUB, { fingerprint: '00000000' }).fingerprint).toBeNull()
    expect(() => parseWatchOnlyImport(ZPUB, { fingerprint: '73c5da' })).toThrow(/8 hex/)
  })

  it('refuses private, testnet, multisig, non-account and garbage input', () => {
    expect(() => parseWatchOnlyImport(MASTER.derive("m/84'/0'/0'").privateExtendedKey)).toThrow(/private key/)
    const tpub = HDKey.fromMasterSeed(new Uint8Array(32).fill(1), { private: 0x04358394, public: 0x043587cf }).derive("m/84'/1'/0'").publicExtendedKey
    expect(() => parseWatchOnlyImport(tpub)).toThrow(/Testnet/)
    const Zpub = HDKey.fromMasterSeed(new Uint8Array(32).fill(1), { private: 0x02aa7a99, public: 0x02aa7ed3 }).publicExtendedKey
    expect(() => parseWatchOnlyImport(Zpub)).toThrow(/Multisig/)
    expect(() => parseWatchOnlyImport(MASTER.derive("m/0'").publicExtendedKey)).toThrow(/Electrum seed wallets \(m\/0h\) are not KeepKey wallets/)
    expect(() => parseWatchOnlyImport(MASTER.publicExtendedKey)).toThrow(/depth-0/)
    expect(() => parseWatchOnlyImport(MASTER.derive("m/84'/0'/0'/0").publicExtendedKey)).toThrow(/depth-4/)
    expect(() => parseWatchOnlyImport(MASTER.derive("m/84'/0'/0").publicExtendedKey)).toThrow(/not hardened/)
    expect(() => parseWatchOnlyImport('hello world')).toThrow(/Not an Electrum wallet file or an extended public key/)
    expect(() => parseWatchOnlyImport(ZPUB.slice(0, -1) + 't')).toThrow(/checksum/)
  })
})

describe('Electrum wallet file import', () => {
  const account = { scriptType: 'p2wpkh' as const, path: [84 + H, H, H], xpub: XPUB84, masterFingerprint: hex.decode('73c5da0a') }

  it('reads path and real fingerprint from the file; its label is not used', () => {
    const w = parseWatchOnlyImport(writeElectrumWallet(account, 'KeepKey'))
    expect(w).toEqual({
      id: 'wo:' + sha(XPUB84), source: 'electrum', scriptType: 'p2wpkh', xpub: XPUB84, key: ZPUB,
      path: [84 + H, H, H], pathAssumed: false, fingerprint: '73c5da0a',
    })
    expect(JSON.stringify(w)).not.toContain('KeepKey')
  })

  it('treats a bare-xpub Electrum wallet as origin unknown', () => {
    const bare = JSON.stringify({ wallet_type: 'standard', use_encryption: false, keystore: { type: 'bip32', xpub: ZPUB, xprv: null, derivation: null, root_fingerprint: null } })
    expect(parseWatchOnlyImport(bare)).toMatchObject({ pathAssumed: true, fingerprint: null, path: [84 + H, H, H] })
    // The account key's own fingerprint is not the master's.
    const own = MASTER.derive("m/84'/0'/0'").fingerprint.toString(16).padStart(8, '0')
    const ownFp = JSON.stringify({ wallet_type: 'standard', keystore: { type: 'bip32', xpub: ZPUB, xprv: null, root_fingerprint: own } })
    expect(parseWatchOnlyImport(ownFp).fingerprint).toBeNull()
  })

  it('reads an Electrum KeepKey hardware keystore', () => {
    const hw = JSON.stringify({ wallet_type: 'standard', keystore: { type: 'hardware', hw_type: 'keepkey', xpub: ZPUB, derivation: "m/84'/0'/0'", root_fingerprint: '73c5da0a', label: 'My KeepKey' } })
    expect(parseWatchOnlyImport(hw)).toMatchObject({ source: 'electrum', pathAssumed: false, fingerprint: '73c5da0a' })
  })

  it('refuses a fingerprint that contradicts the file, and multisig, imported, encrypted and private-key files', () => {
    expect(() => parseWatchOnlyImport(writeElectrumWallet(account, 'x'), { fingerprint: '01020304' })).toThrow(/differs from the file/)
    expect(() => parseWatchOnlyImport(JSON.stringify({ wallet_type: '2of3', x1: { type: 'bip32', xpub: ZPUB } }))).toThrow(/multisig/)
    expect(() => parseWatchOnlyImport(JSON.stringify({ wallet_type: 'imported', addresses: {} }))).toThrow(/imported/)
    expect(() => parseWatchOnlyImport('QklFMQ' + 'A'.repeat(60))).toThrow(/encrypted/)
    expect(() => parseWatchOnlyImport(JSON.stringify({ wallet_type: 'standard', keystore: { type: 'bip32', xpub: ZPUB, xprv: 'zprv...' } }))).toThrow(/private key/)
    const seed = JSON.stringify({ wallet_type: 'standard', keystore: { type: 'bip32', xpub: MASTER.derive("m/0'").publicExtendedKey, xprv: null, derivation: "m/0'" } })
    expect(() => parseWatchOnlyImport(seed)).toThrow(/Electrum-seed/)
  })
})

describe('watch-only id and host receive address', () => {
  it('is wo: + sha256 of the sorted standard xpubs, independent of order', () => {
    expect(watchOnlyImportId([XPUB84])).toBe('wo:' + sha(XPUB84))
    expect(watchOnlyImportId([XPUB84, XPUB44])).toBe(watchOnlyImportId([XPUB44, XPUB84]))
    expect(watchOnlyImportId([XPUB84, XPUB44])).toMatch(/^wo:[0-9a-f]{64}$/)
    // A zpub and the same key as a ypub are one wallet id (the key, not the prefix).
    expect(parseWatchOnlyImport(toSlip132(XPUB84, 'p2sh-p2wpkh'), {}).id).toBe(parseWatchOnlyImport(ZPUB).id)
  })

  it('derives the BIP84 test vector receive addresses from the xpub', () => {
    expect(deriveAddress(account84(), 0, 0)).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')
    expect(deriveAddress(account84(), 0, 1)).toBe('bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g')
    expect(deriveAddress(account84(), 1, 0)).toBe('bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el')
    expect(() => deriveAddress(account84(), 0, -1)).toThrow(/out of range/)
  })
})

function account84() {
  return { scriptType: 'p2wpkh' as const, path: [84 + H, H, H], xpub: XPUB84 }
}
