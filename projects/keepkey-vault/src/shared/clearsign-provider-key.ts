/**
 * Derive a clear-sign PROVIDER signing key from a BIP-85 child mnemonic.
 *
 * The ceremony: a KeepKey derives a BIP-85 child mnemonic (device-side), and
 * that mnemonic's master key becomes the provider's signing key. The private
 * key is then loaded into a live service, where it is FULLY EXPOSED — exactly
 * like any hot key.
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
import { utils as ethersUtils } from 'ethers'
import { createHash } from 'crypto'

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
  /** 32-byte private key, hex, no 0x. Hot the moment it leaves this process. */
  privateKeyHex: string
  /** 33-byte COMPRESSED secp256k1 public key, hex, no 0x — what the device loads. */
  publicKeyHex: string
  /** 8 hex chars. Must equal what the device shows on the trust prompt. */
  fingerprint: string
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
 */
export function deriveProviderKey(childMnemonic: string): ProviderKey {
  const mnemonic = String(childMnemonic || '').trim().replace(/\s+/g, ' ').toLowerCase()
  if (!mnemonic) throw new Error('BIP-85 child mnemonic is required')
  if (!validateMnemonic(mnemonic)) {
    throw new Error('BIP-85 child mnemonic failed BIP-39 checksum validation')
  }

  const seed = mnemonicToSeedSync(mnemonic)
  const node = ethersUtils.HDNode.fromSeed(seed)

  const privateKeyHex = node.privateKey.replace(/^0x/i, '').toLowerCase()
  const publicKeyHex = ethersUtils
    .computePublicKey(node.privateKey, /* compressed */ true)
    .replace(/^0x/i, '')
    .toLowerCase()

  return { privateKeyHex, publicKeyHex, fingerprint: providerFingerprint(publicKeyHex) }
}

/** What gets written to disk for the live service to load. */
export interface ProviderKeyFile {
  format: 'keepkey-clearsign-provider-key-v1'
  alias: string
  /** BIP-85 parameters, so the ceremony can be repeated and audited. */
  ceremony: { bip85WordCount: number; bip85Index: number; derivationPath: string; deviceFingerprint?: string; createdAt: string }
  publicKeyHex: string
  fingerprint: string
  privateKeyHex: string
  /** Read by humans, not code. */
  warning: string
}

export const PROVIDER_KEY_WARNING =
  'This file contains a live signing key in plaintext. Anyone holding it can sign '
  + 'clear-sign context that KeepKey devices will DISPLAY under this provider identity. '
  + 'It cannot forge transactions and cannot remove the raw review, but it can mislabel '
  + 'what a transaction appears to do. Treat it as a production secret.'

export function buildProviderKeyFile(opts: {
  key: ProviderKey
  alias: string
  bip85WordCount: number
  bip85Index: number
  deviceFingerprint?: string
  createdAt: string
}): ProviderKeyFile {
  return {
    format: 'keepkey-clearsign-provider-key-v1',
    alias: opts.alias,
    ceremony: {
      bip85WordCount: opts.bip85WordCount,
      bip85Index: opts.bip85Index,
      derivationPath: PROVIDER_KEY_PATH,
      deviceFingerprint: opts.deviceFingerprint,
      createdAt: opts.createdAt,
    },
    publicKeyHex: opts.key.publicKeyHex,
    fingerprint: opts.key.fingerprint,
    privateKeyHex: opts.key.privateKeyHex,
    warning: PROVIDER_KEY_WARNING,
  }
}
