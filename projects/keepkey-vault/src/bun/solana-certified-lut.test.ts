import { describe, test, expect } from 'bun:test'
import { randomBytes } from 'node:crypto'

import {
  buildLutAttestationPreimage,
  signCertifiedSolanaLutAttestation,
  SOL_MAX_LUT_ACCOUNTS,
} from './solana-certified-lut'
import production from '../../__tests__/fixtures/clearsign-production-catalog-batch1.json'

// The production Solana scope-501 certificate (2026-10-16 ceremony). Public
// data only — contains no private key material.
const SOLANA_CERT_HEX = production.certificates['501']

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
      .toThrow(/does not match the certificate's delegate/)
  })
})
