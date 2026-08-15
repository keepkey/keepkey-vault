/**
 * Provider-key ceremony: derivation must be deterministic, and the fingerprint
 * must match what the DEVICE shows.
 *
 * The fingerprint is the only thing an operator can compare between the screen
 * and the file they are about to hand a live service. If it disagrees, they
 * cannot tell which key they trusted — which defeats the confirm prompt that
 * firmware calls the thing "the whole trust model hangs on".
 *
 * Firmware (signed_metadata.c, signed_metadata_pubkey_fingerprint):
 *     sha256_Raw(pubkey, 33, digest); data2hex(digest, 4, out);
 * i.e. first 4 bytes of SHA-256 over the 33-byte COMPRESSED pubkey, 8 hex chars.
 *
 * Run: bun test __tests__/clearsign-provider-key.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { createHash } from 'crypto'
import {
  deriveProviderKey,
  providerFingerprint,
  buildProviderKeyFile,
  PROVIDER_KEY_PATH,
  PROVIDER_KEY_WARNING,
} from '../src/shared/clearsign-provider-key'

// BIP-39 test vector mnemonic. NEVER a real provider key.
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('deriveProviderKey', () => {
  test('is deterministic — the whole point of a repeatable ceremony', () => {
    const a = deriveProviderKey(ABANDON)
    const b = deriveProviderKey(ABANDON)
    expect(a).toEqual(b)
    expect(a.publicKeyHex).toBe('03d902f35f560e0470c63313c7369168d9d7df2d49bf295fd9fb7cb109ccee0494')
    expect(a.fingerprint).toBe('b690735f')
  })

  test('returns a 33-byte COMPRESSED pubkey — what the device loads', () => {
    const { publicKeyHex } = deriveProviderKey(ABANDON)
    expect(publicKeyHex).toHaveLength(66)
    // Compressed keys start 02 or 03; an uncompressed 04 key would be rejected
    // by LoadClearsignSigner, which demands exactly 33 bytes.
    expect(['02', '03']).toContain(publicKeyHex.slice(0, 2))
  })

  test('private key is 32 bytes', () => {
    expect(deriveProviderKey(ABANDON).privateKeyHex).toHaveLength(64)
  })

  test('normalises whitespace and case rather than deriving a different key', () => {
    expect(deriveProviderKey(`  ${ABANDON.toUpperCase()}  `.replace(/ /g, '  ')))
      .toEqual(deriveProviderKey(ABANDON))
  })

  test('rejects a mnemonic that fails the BIP-39 checksum', () => {
    // A typo must not silently yield a valid-looking key whose fingerprint
    // would never match any device, leaving the operator unable to tell a typo
    // from a bug.
    const typo = ABANDON.replace(/about$/, 'abandon')
    expect(() => deriveProviderKey(typo)).toThrow('checksum')
  })

  test('rejects empty input', () => {
    expect(() => deriveProviderKey('')).toThrow('required')
  })
})

describe('providerFingerprint matches the firmware algorithm', () => {
  test('is sha256(compressed pubkey)[0:4] as hex', () => {
    const { publicKeyHex, fingerprint } = deriveProviderKey(ABANDON)
    const expected = createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 8)
    expect(fingerprint).toBe(expected)
    expect(fingerprint).toHaveLength(8)
  })

  test('accepts a 0x prefix and mixed case — operators paste both', () => {
    const { publicKeyHex, fingerprint } = deriveProviderKey(ABANDON)
    expect(providerFingerprint('0x' + publicKeyHex.toUpperCase())).toBe(fingerprint)
  })

  test('refuses an uncompressed or truncated key instead of hashing it anyway', () => {
    expect(() => providerFingerprint('04' + '11'.repeat(64))).toThrow('33 bytes')
    expect(() => providerFingerprint('03' + '11'.repeat(10))).toThrow('33 bytes')
  })
})

describe('buildProviderKeyFile', () => {
  const file = buildProviderKeyFile({
    key: deriveProviderKey(ABANDON),
    alias: 'Pioneer',
    bip85WordCount: 12,
    bip85Index: 0,
    deviceFingerprint: 'deadbeef',
    createdAt: '2026-08-15T00:00:00.000Z',
  })

  test('records the ceremony so the key can be re-derived and audited', () => {
    expect(file.ceremony).toEqual({
      bip85WordCount: 12,
      bip85Index: 0,
      derivationPath: PROVIDER_KEY_PATH,
      deviceFingerprint: 'deadbeef',
      createdAt: '2026-08-15T00:00:00.000Z',
    })
  })

  test('carries the fingerprint the operator will compare against the device', () => {
    expect(file.fingerprint).toBe('b690735f')
    expect(file.publicKeyHex).toBe(deriveProviderKey(ABANDON).publicKeyHex)
  })

  test('states plainly that it holds a live key, and what it can and cannot do', () => {
    // The honesty is the feature: this key can MISLABEL a transaction but can
    // never conceal one, because a runtime signer is annotation-only.
    expect(file.warning).toBe(PROVIDER_KEY_WARNING)
    expect(file.warning).toContain('plaintext')
    expect(file.warning).toContain('mislabel')
    expect(file.warning).toContain('cannot remove the raw review')
  })

  test('is versioned, so a later format change is detectable', () => {
    expect(file.format).toBe('keepkey-clearsign-provider-key-v1')
  })
})
