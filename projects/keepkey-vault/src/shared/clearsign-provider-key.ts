/**
 * Derive a clear-sign PROVIDER signing key from a BIP-85 child mnemonic.
 *
 * The ceremony: a KeepKey derives a BIP-85 child mnemonic (device-side), and
 * that mnemonic's master key becomes the provider's signing key.
 *
 * Desktop NEVER writes this private key to disk. Studio exports only the public
 * key and fingerprint; when it must sign, the operator re-enters the words the
 * device shows and the key lives in memory for that Studio session only
 * (clearsign-provider-session.ts), zeroed when the session ends.
 *
 * BIP-85 buys no custody here and this module must not imply otherwise. What it
 * buys is a ceremony that is deterministic, repeatable and documented: the key
 * can be re-derived from the device and index rather than existing as a file of
 * unexplained origin. That is what makes an unsigned provider *auditable* rather
 * than merely unverified.
 *
 * The device never verifies any of this. It only ever sees the PUBLIC key, and
 * only after a human confirms the alias + fingerprint on screen
 * (signed_metadata_confirm_load). A provider key is annotation-only: it can add
 * decoded screens, never remove the raw review.
 */
import { mnemonicToSeedSync, validateMnemonic } from 'bip39'
import { secp256k1 } from '@noble/curves/secp256k1'
import { createHash, createHmac } from 'crypto'

/**
 * The BIP-85 child mnemonic IS the key material, so the provider key is that
 * mnemonic's master private key — no further path.
 *
 * Deliberately not a coin-type path: this key signs clear-sign descriptors, not
 * transactions on any chain, and borrowing m/44'/60'/… would imply an Ethereum
 * account that does not exist. Fixed and documented matters more than clever.
 */
export const PROVIDER_KEY_PATH = 'm' as const

export interface ProviderKey {
  /** 32-byte private key. Caller owns it and must zero it (fill(0)) when done. */
  privateKey: Uint8Array
  /** 33-byte COMPRESSED secp256k1 public key, hex, no 0x — what the device loads. */
  publicKeyHex: string
  /** 8 hex chars. Must equal what the device shows on the trust prompt. */
  fingerprint: string
}

export const PROVIDER_BIP85_WORD_COUNTS = [12, 18, 24] as const

/**
 * Bind the host-entered mnemonic to the exact ceremony the device was asked
 * to perform. Without this check, a stale mnemonic can be saved with plausible
 * but false word-count/index provenance.
 */
export function validateProviderCeremony(opts: {
  childMnemonic: string
  wordCount: number
  index: number
}): string {
  if (!PROVIDER_BIP85_WORD_COUNTS.includes(opts.wordCount as 12 | 18 | 24)) {
    throw new Error('BIP-85 word count must be 12, 18, or 24')
  }
  if (!Number.isSafeInteger(opts.index) || opts.index < 0 || opts.index > 0x7fffffff) {
    throw new Error('BIP-85 index must be an integer from 0 to 2147483647')
  }

  const mnemonic = String(opts.childMnemonic || '').trim().replace(/\s+/g, ' ').toLowerCase()
  const actualWordCount = mnemonic ? mnemonic.split(' ').length : 0
  if (actualWordCount !== opts.wordCount) {
    throw new Error(`BIP-85 mnemonic has ${actualWordCount} words; expected ${opts.wordCount}`)
  }
  return mnemonic
}

/**
 * Fingerprint exactly as firmware computes it: first 4 bytes of SHA-256 over
 * the 33-byte compressed pubkey, hex (signed_metadata_pubkey_fingerprint —
 * `sha256_Raw(pubkey, 33, digest); data2hex(digest, 4, out)`).
 *
 * If this ever disagrees with the device, the operator cannot verify which key
 * they are trusting, which is the entire point of the confirm screen.
 */
export function providerFingerprint(compressedPubkeyHex: string): string {
  const hex = compressedPubkeyHex.replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]{66}$/.test(hex)) {
    throw new Error('Provider public key must be 33 bytes (66 hex chars), compressed')
  }
  return createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex').slice(0, 8)
}

/**
 * Derive the provider key from a BIP-85 child mnemonic.
 *
 * Throws on an invalid mnemonic rather than deriving from garbage — a key
 * derived from a typo would produce a fingerprint that silently never matches
 * any device, and the operator would have no way to tell that from a bug.
 *
 * BIP-32 master key (HMAC-SHA512 "Bitcoin seed"), kept in buffers this function
 * zeroes itself, so the only copy of the secret left is the returned privateKey.
 */
export function deriveProviderKey(childMnemonic: string): ProviderKey {
  const mnemonic = String(childMnemonic || '').trim().replace(/\s+/g, ' ').toLowerCase()
  if (!mnemonic) throw new Error('BIP-85 child mnemonic is required')
  if (!validateMnemonic(mnemonic)) {
    throw new Error('BIP-85 child mnemonic failed BIP-39 checksum validation')
  }

  const seed = mnemonicToSeedSync(mnemonic)
  const master = createHmac('sha512', 'Bitcoin seed').update(seed as Uint8Array).digest()
  seed.fill(0)
  const privateKey = new Uint8Array(master.subarray(0, 32))
  master.fill(0)
  if (!secp256k1.utils.isValidPrivateKey(privateKey)) {
    privateKey.fill(0)
    throw new Error('BIP-85 child mnemonic yields an invalid master key; use another index')
  }
  const publicKeyHex = Buffer.from(secp256k1.getPublicKey(privateKey, true)).toString('hex')
  return { privateKey, publicKeyHex, fingerprint: providerFingerprint(publicKeyHex) }
}
