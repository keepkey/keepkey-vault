import { describe, test, expect } from 'bun:test'
import { randomBytes } from 'node:crypto'

import {
  buildLutAttestationPreimage,
  signCertifiedSolanaLutAttestation,
  SOL_MAX_LUT_ACCOUNTS,
} from './solana-certified-lut'

// Real Solana scope-501 certificate issued 2026-08-24 by the master root
// signer (docs/certs/solana-scope-501-certificate.json). Public data only —
// contains no private key material.
const SOLANA_CERT_HEX = '0101000001f56c68c8804b6565704b6579205661756c74000000000000000000000000000000000000000342f5f9704494b3f9bd72295eecaf29d783d23ea02b2dc9f48abcd2e46d4850cfa2753fac6068a45747a32a4a39f249af72b55370f3491913b7fb9a80207d619b3b4fca6750fc1fdc790da5562b42a351e12cde3c0f084056a24ca8d1bf2c36b5'

describe('buildLutAttestationPreimage', () => {
  test('matches firmware layout: 25-byte tag + 32-byte hash + LE32 count + accounts', () => {
    const hash = randomBytes(32)
    const accounts = [randomBytes(32), randomBytes(32)]
    const preimage = buildLutAttestationPreimage(hash, accounts)
    expect(preimage.length).toBe(25 + 32 + 4 + 64)
    expect(preimage.subarray(0, 25).toString('ascii')).toBe('KeepKeySolanaTxAccounts/1')
    expect(preimage.subarray(25, 57)).toEqual(hash)
    expect(preimage.readUInt32LE(57)).toBe(2)
    expect(preimage.subarray(61, 93)).toEqual(accounts[0])
    expect(preimage.subarray(93, 125)).toEqual(accounts[1])
  })

  test('rejects zero, over-cap, and malformed accounts', () => {
    const hash = randomBytes(32)
    expect(() => buildLutAttestationPreimage(hash, [])).toThrow()
    expect(() => buildLutAttestationPreimage(hash, Array.from({ length: SOL_MAX_LUT_ACCOUNTS + 1 }, () => randomBytes(32)))).toThrow()
    expect(() => buildLutAttestationPreimage(hash, [randomBytes(31)])).toThrow()
    expect(() => buildLutAttestationPreimage(randomBytes(31), [randomBytes(32)])).toThrow()
  })
})

describe('signCertifiedSolanaLutAttestation', () => {
  test('accepts the real Solana-scoped certificate but rejects a mismatched private key', () => {
    const wrongKey = randomBytes(32).toString('hex')
    expect(() => signCertifiedSolanaLutAttestation(SOLANA_CERT_HEX, wrongKey, randomBytes(32), [randomBytes(32)]))
      .toThrow(/does not match reviewed signer/)
  })
})
