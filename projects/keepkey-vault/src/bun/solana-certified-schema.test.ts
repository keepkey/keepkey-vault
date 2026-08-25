import { describe, test, expect } from 'bun:test'
import { randomBytes } from 'node:crypto'

import {
  serializeSolanaSchema,
  solanaSchemaCoverage,
  signCertifiedSolanaSchema,
  CERTIFIED_SOLANA_CATALOG,
} from './solana-certified-schema'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sdkFixture = require('../../../keepkey-sdk/tests/fixtures/solana-schema')

// Real Solana scope-501 certificate issued 2026-08-24 by the master root
// signer (docs/certs/solana-scope-501-certificate.json). Public data only.
const SOLANA_CERT_HEX = '0101000001f56c68c8804b6565704b6579205661756c74000000000000000000000000000000000000000342f5f9704494b3f9bd72295eecaf29d783d23ea02b2dc9f48abcd2e46d4850cfa2753fac6068a45747a32a4a39f249af72b55370f3491913b7fb9a80207d619b3b4fca6750fc1fdc790da5562b42a351e12cde3c0f084056a24ca8d1bf2c36b5'

describe('serializeSolanaSchema', () => {
  test('is byte-for-byte identical to the SDK offline fixture (drift gate)', () => {
    const oursNative = serializeSolanaSchema(CERTIFIED_SOLANA_CATALOG.relayDepositNative)
    const theirsNative = sdkFixture.serializeSchema(sdkFixture.CATALOG.relayDepositNative)
    expect(Buffer.from(oursNative)).toEqual(Buffer.from(theirsNative))

    const oursToken = serializeSolanaSchema(CERTIFIED_SOLANA_CATALOG.relayDepositToken)
    const theirsToken = sdkFixture.serializeSchema(sdkFixture.CATALOG.relayDepositToken)
    expect(Buffer.from(oursToken)).toEqual(Buffer.from(theirsToken))
  })

  test('coverage exactly matches the real 48-byte Relay instruction data', () => {
    expect(solanaSchemaCoverage(CERTIFIED_SOLANA_CATALOG.relayDepositNative)).toBe(48)
  })

  test('the SDK fixture round-trip-decodes what we serialize', () => {
    const payload = serializeSolanaSchema(CERTIFIED_SOLANA_CATALOG.relayDepositNative)
    const decoded = sdkFixture.decodeSchema(payload)
    expect(decoded.instructionName).toBe('depositNative')
    expect(decoded.args.length).toBe(2)
  })
})

describe('signCertifiedSolanaSchema', () => {
  test('accepts the real Solana-scoped certificate but rejects a mismatched private key', () => {
    const wrongKey = randomBytes(32).toString('hex')
    expect(() => signCertifiedSolanaSchema(SOLANA_CERT_HEX, wrongKey, CERTIFIED_SOLANA_CATALOG.relayDepositNative))
      .toThrow(/does not match reviewed signer/)
  })
})
