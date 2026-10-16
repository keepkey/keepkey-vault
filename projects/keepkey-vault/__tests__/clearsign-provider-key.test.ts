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
import { readFileSync } from 'fs'
import { join } from 'path'
import { mnemonicToSeedSync } from 'bip39'
import { utils as ethersUtils } from 'ethers'
import * as providerKeyModule from '../src/shared/clearsign-provider-key'
import { createProviderKeySession } from '../src/bun/clearsign-provider-session'

const { deriveProviderKey, providerFingerprint, validateProviderCeremony } = providerKeyModule

// BIP-39 test vector mnemonic. NEVER a real provider key.
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('validateProviderCeremony', () => {
  test('binds the mnemonic word count to the requested device ceremony', () => {
    expect(validateProviderCeremony({ childMnemonic: ABANDON, wordCount: 12, index: 0 })).toBe(ABANDON)
    expect(() => validateProviderCeremony({ childMnemonic: ABANDON, wordCount: 24, index: 0 }))
      .toThrow('has 12 words; expected 24')
  })

  test('accepts only supported BIP-85 word counts and non-hardened indices', () => {
    expect(() => validateProviderCeremony({ childMnemonic: ABANDON, wordCount: 15, index: 0 }))
      .toThrow('12, 18, or 24')
    expect(() => validateProviderCeremony({ childMnemonic: ABANDON, wordCount: 12, index: -1 }))
      .toThrow('integer from 0')
    expect(() => validateProviderCeremony({ childMnemonic: ABANDON, wordCount: 12, index: 0x80000000 }))
      .toThrow('2147483647')
  })
})

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

  test('private key is 32 zeroable bytes, the BIP-32 master key of the child mnemonic', () => {
    const { privateKey } = deriveProviderKey(ABANDON)
    expect(privateKey).toBeInstanceOf(Uint8Array)
    expect(privateKey).toHaveLength(32)
    const master = ethersUtils.HDNode.fromSeed(mnemonicToSeedSync(ABANDON)).privateKey.slice(2)
    expect(Buffer.from(privateKey).toString('hex')).toBe(master)
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

// Owner rule 2026-10-16: the provider private key NEVER touches disk.
describe('provider key never written to disk', () => {
  const SRC = join(import.meta.dir, '..', 'src')

  test('the key module exports no file writer and imports no fs', () => {
    expect(Object.keys(providerKeyModule)).not.toContain('writeProviderKeyFile')
    expect(Object.keys(providerKeyModule)).not.toContain('buildProviderKeyFile')
    for (const file of ['shared/clearsign-provider-key.ts', 'bun/clearsign-provider-session.ts']) {
      expect(readFileSync(join(SRC, file), 'utf8')).not.toMatch(/from ['"](node:)?fs['"]/)
    }
  })

  test('the Desktop handler keeps the key in the session, not in ~/Downloads', () => {
    const index = readFileSync(join(SRC, 'bun/index.ts'), 'utf8')
    const handler = index.slice(index.indexOf('clearsignDeriveProviderKey:'), index.indexOf('clearsignListEvents:'))
    expect(handler).toContain('providerKeySession.derive(params)')
    expect(handler).not.toContain('Downloads')
    expect(index).not.toContain('keepkey-provider-')
  })
})

describe('provider key session', () => {
  const ceremony = { childMnemonic: ABANDON, alias: 'Acme Labs', wordCount: 12, index: 0 }

  function session(advanced = { on: true }) {
    const keys: Uint8Array[] = []
    const s = createProviderKeySession(
      () => { if (!advanced.on) throw new Error('ClearSign Studio requires AdvancedMode on the connected device') },
      (m) => { const k = deriveProviderKey(m); keys.push(k.privateKey); return k },
    )
    return { s, keys, advanced }
  }

  test('derive requires AdvancedMode', () => {
    const { s, keys } = session({ on: false })
    expect(() => s.derive(ceremony)).toThrow('AdvancedMode')
    expect(keys).toHaveLength(0)
  })

  test('derive returns only the public half', () => {
    const { s } = session()
    const identity = s.derive(ceremony)
    expect(identity).toEqual({ alias: 'Acme Labs', publicKeyHex: deriveProviderKey(ABANDON).publicKeyHex, fingerprint: 'b690735f' })
    expect(JSON.stringify(identity)).not.toContain(Buffer.from(deriveProviderKey(ABANDON).privateKey).toString('hex'))
  })

  test('clear zeroes the key; AdvancedMode off or a new derive clears it too', () => {
    const { s, keys, advanced } = session()
    s.derive(ceremony)
    s.derive({ ...ceremony, alias: 'Acme Two' })
    expect(keys[0].every(b => b === 0)).toBe(true)
    expect(s.clear()).toBe(true)
    expect(keys[1].every(b => b === 0)).toBe(true)
    expect(s.clear()).toBe(false)

    s.derive(ceremony)
    advanced.on = false
    expect(() => s.derive(ceremony)).toThrow('AdvancedMode')
    expect(keys[2].every(b => b === 0)).toBe(true)
  })

  test('rejects a bad alias or a ceremony mismatch before deriving', () => {
    const { s, keys } = session()
    expect(() => s.derive({ ...ceremony, alias: 'Acme%' })).toThrow('Alias')
    expect(() => s.derive({ ...ceremony, wordCount: 24 })).toThrow('expected 24')
    expect(keys).toHaveLength(0)
  })
})
