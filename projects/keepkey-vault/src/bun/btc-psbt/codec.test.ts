import { describe, expect, it } from 'bun:test'
import { HDKey } from '@scure/bip32'
import { hex } from '@scure/base'
import { mnemonicToSeedSync } from 'bip39'
import { masterFingerprintFromDepth1Xpub, readElectrumWallet, toSlip132, toStandardXpub, writeElectrumWallet } from './codec'

// BIP84 test vector: "abandon ... about", account m/84'/0'/0'.
const ZPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs'
const ZPRV = 'zprvAdG4iTXWBoARxkkzNpNh8r6Qag3irQB8PzEMkAFeTRXxHpbF9z4QgEvBRmfvqWvGp42t42nvgGpNgYSJA9iefm1yYNZKEm7z6qUWCroSQnE'
const MASTER = HDKey.fromMasterSeed(new Uint8Array(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')))
const H = 0x80000000
const ACCOUNT_XPUB = MASTER.derive("m/84'/0'/0'").publicExtendedKey

describe('SLIP-132', () => {
  it('converts the BIP84 test vector zpub to the standard xpub and back', () => {
    expect(toStandardXpub(ZPUB)).toEqual({ xpub: ACCOUNT_XPUB, scriptType: 'p2wpkh' })
    expect(toSlip132(ACCOUNT_XPUB, 'p2wpkh')).toBe(ZPUB)
    const ypub = toSlip132(ACCOUNT_XPUB, 'p2sh-p2wpkh')
    expect(ypub.startsWith('ypub')).toBe(true)
    expect(toStandardXpub(ypub)).toEqual({ xpub: ACCOUNT_XPUB, scriptType: 'p2sh-p2wpkh' })
    expect(toStandardXpub(ACCOUNT_XPUB).scriptType).toBe('p2pkh')
  })

  it('refuses private, testnet, multisig and corrupted keys', () => {
    expect(() => toStandardXpub(ZPRV)).toThrow(/private key/)
    expect(() => toStandardXpub(MASTER.derive("m/84'/0'/0'").privateExtendedKey)).toThrow(/private key/)
    const tpub = HDKey.fromMasterSeed(new Uint8Array(32).fill(1), { private: 0x04358394, public: 0x043587cf }).publicExtendedKey
    expect(() => toStandardXpub(tpub)).toThrow(/Testnet/)
    const vpub = HDKey.fromMasterSeed(new Uint8Array(32).fill(1), { private: 0x045f18bc, public: 0x045f1cf6 }).publicExtendedKey
    expect(() => toStandardXpub(vpub)).toThrow(/Testnet/)
    const Zpub = HDKey.fromMasterSeed(new Uint8Array(32).fill(1), { private: 0x02aa7a99, public: 0x02aa7ed3 }).publicExtendedKey
    expect(() => toStandardXpub(Zpub)).toThrow(/Multisig/)
    expect(() => toStandardXpub(ZPUB.slice(0, -1) + 't')).toThrow(/checksum/)
    expect(() => toSlip132(ZPUB, 'p2pkh')).toThrow(/standard xpub/)
  })

  it('reads the master fingerprint from a depth-1 key only', () => {
    expect(hex.encode(masterFingerprintFromDepth1Xpub(MASTER.derive("m/84'").publicExtendedKey))).toBe('73c5da0a')
    // The device answers m/84' with SPENDWITNESS as a zpub.
    expect(hex.encode(masterFingerprintFromDepth1Xpub(toSlip132(MASTER.derive("m/84'").publicExtendedKey, 'p2wpkh')))).toBe('73c5da0a')
    expect(() => masterFingerprintFromDepth1Xpub(ACCOUNT_XPUB)).toThrow(/depth-1/)
  })
})

describe('Electrum wallet file', () => {
  const account = { scriptType: 'p2wpkh' as const, path: [84 + H, H, H], xpub: ACCOUNT_XPUB, masterFingerprint: hex.decode('73c5da0a') }

  it('writes an unencrypted bip32 watch-only file without seed_version and reads it back', () => {
    const text = writeElectrumWallet(account, 'KeepKey')
    expect(JSON.parse(text)).toEqual({
      wallet_type: 'standard',
      use_encryption: false,
      keystore: { type: 'bip32', xpub: ZPUB, xprv: null, derivation: "m/84'/0'/0'", root_fingerprint: '73c5da0a', label: 'KeepKey' },
    })
    expect(readElectrumWallet(text)).toEqual({ xpub: ACCOUNT_XPUB, scriptType: 'p2wpkh', path: [84 + H, H, H], masterFingerprint: hex.decode('73c5da0a') })
  })

  it('reads a hardware keystore and a bare one without origin', () => {
    const hw = { wallet_type: 'standard', use_encryption: false, keystore: { type: 'hardware', hw_type: 'keepkey', xpub: ZPUB, derivation: "m/84h/0h/0h", label: 'x' } }
    expect(readElectrumWallet(JSON.stringify(hw)).path).toEqual([84 + H, H, H])
    const bare = { wallet_type: 'standard', keystore: { type: 'bip32', xpub: ZPUB, xprv: null } }
    expect(readElectrumWallet(JSON.stringify(bare))).toEqual({ xpub: ACCOUNT_XPUB, scriptType: 'p2wpkh' })
  })

  it('refuses encrypted, multisig, imported, private-key and mismatched files', () => {
    expect(() => readElectrumWallet('QklFMQ' + 'A'.repeat(40))).toThrow(/encrypted/)
    expect(() => readElectrumWallet('BIE2xyz')).toThrow(/encrypted/)
    expect(() => readElectrumWallet(JSON.stringify({ wallet_type: '2of3', x1: { type: 'bip32', xpub: ZPUB } }))).toThrow(/multisig/)
    expect(() => readElectrumWallet(JSON.stringify({ wallet_type: 'imported', addresses: {} }))).toThrow(/imported/)
    expect(() => readElectrumWallet(JSON.stringify({ wallet_type: 'standard', keystore: { type: 'bip32', xpub: ZPUB, xprv: ZPRV } }))).toThrow(/private key/)
    expect(() => readElectrumWallet(JSON.stringify({ wallet_type: 'standard', keystore: { type: 'bip32', xpub: ZPUB, derivation: "m/44'/0'/0'" } }))).toThrow(/does not fit/)
    const seedWallet = MASTER.derive("m/0'").publicExtendedKey
    expect(() => readElectrumWallet(JSON.stringify({ wallet_type: 'standard', keystore: { type: 'bip32', xpub: seedWallet } }))).toThrow(/Electrum-seed/)
    expect(() => readElectrumWallet('not json')).toThrow(/Not an Electrum wallet/)
  })
})
