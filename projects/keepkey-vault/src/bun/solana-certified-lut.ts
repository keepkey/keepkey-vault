import { createHash } from 'node:crypto'
import { utils as ethersUtils } from 'ethers'

import {
  ALPHA_DELEGATE_PUBLIC_KEY,
  ALPHA_DELEGATE_FINGERPRINT,
  CLEARSIGN_SCOPE_SOLANA,
  inspectAlphaCertificate,
} from './clearsign-alpha-ceremony'

/**
 * Certified Solana LUT account attestation (KKSOLSW1 certified path).
 *
 * Preimage layout (must match lib/firmware/solana.c solana_lut_accounts_preimage
 * and solana_lut_accounts_certified exactly):
 *   "KeepKeySolanaTxAccounts/1" (25 bytes, no NUL) || message_hash(32)
 *   || count(uint32 LE) || account[0..count-1] (32 bytes each)
 *
 * Firmware verifies SHA256(preimage) against the certificate's delegate with a
 * plain 64-byte compact secp256k1 signature (r||s, no recovery byte).
 */

const LUT_TAG = Buffer.from('KeepKeySolanaTxAccounts/1', 'ascii')
export const SOL_PUBKEY_SIZE = 32
export const SOL_MAX_LUT_ACCOUNTS = 8

function hexBytes(value: string, length: number, label: string): Buffer {
  const clean = String(value || '').replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length !== length * 2) {
    throw new Error(`${label} must be exactly ${length} bytes of hex`)
  }
  return Buffer.from(clean, 'hex')
}

/** Build the exact preimage bytes the device hashes and verifies. */
export function buildLutAttestationPreimage(messageHash: Buffer, accounts: Buffer[]): Buffer {
  if (messageHash.length !== 32) throw new Error('message hash must be exactly 32 bytes')
  if (accounts.length === 0 || accounts.length > SOL_MAX_LUT_ACCOUNTS) {
    throw new Error(`lut account count must be 1-${SOL_MAX_LUT_ACCOUNTS}`)
  }
  for (const account of accounts) {
    if (account.length !== SOL_PUBKEY_SIZE) throw new Error('every lut account must be exactly 32 bytes')
  }
  const count = Buffer.alloc(4)
  count.writeUInt32LE(accounts.length)
  return Buffer.concat([LUT_TAG, messageHash, count, ...accounts])
}

export interface CertifiedLutAttestation {
  lutSignature: string // 0x-prefixed 64-byte compact secp256k1 signature
  certificateHex: string
  keyId: number // CERTIFIED_METADATA_KEY_ID sentinel (0x80)
  fingerprint: string
  alias: string
}

/** Sign the canonical LUT account list for one exact Solana message, using the
 * Solana-scoped (501) delegate certificate and its private key. The private
 * key never leaves this process. */
export function signCertifiedSolanaLutAttestation(
  certificateHex: string,
  delegatePrivateKeyHex: string,
  messageHash: Buffer,
  accounts: Buffer[],
): CertifiedLutAttestation {
  const certificate = hexBytes(certificateHex, 139, 'solana certificate')
  const certInfo = inspectAlphaCertificate(certificate.toString('hex'))
  if (certInfo.chainId !== CLEARSIGN_SCOPE_SOLANA) {
    throw new Error(`certificate is scoped to ${certInfo.chainId}, not Solana (${CLEARSIGN_SCOPE_SOLANA})`)
  }
  const privateKey = hexBytes(delegatePrivateKeyHex, 32, 'delegate private key')
  const signingKey = new ethersUtils.SigningKey(`0x${privateKey.toString('hex')}`)
  const publicKey = ethersUtils.computePublicKey(signingKey.publicKey, true).slice(2).toLowerCase()
  if (publicKey !== ALPHA_DELEGATE_PUBLIC_KEY) {
    throw new Error(`delegate private key does not match reviewed signer ${ALPHA_DELEGATE_FINGERPRINT}`)
  }

  const preimage = buildLutAttestationPreimage(messageHash, accounts)
  const digest = createHash('sha256').update(preimage).digest()
  const signature = signingKey.signDigest(`0x${digest.toString('hex')}`)
  const compact = Buffer.concat([
    hexBytes(signature.r, 32, 'signature r'),
    hexBytes(signature.s, 32, 'signature s'),
  ])
  return {
    lutSignature: `0x${compact.toString('hex')}`,
    certificateHex: certificate.toString('hex'),
    keyId: 0x80,
    fingerprint: ALPHA_DELEGATE_FINGERPRINT,
    alias: certInfo.alias,
  }
}

/** Independent verification mirroring clearsign_root_verify_delegate_attestation,
 * for tests and pre-flight checks before a signature is sent to the device. */
export function verifyCertifiedSolanaLutAttestation(
  certificateHex: string,
  messageHash: Buffer,
  accounts: Buffer[],
  lutSignatureHex: string,
): boolean {
  const certInfo = inspectAlphaCertificate(hexBytes(certificateHex, 139, 'solana certificate').toString('hex'))
  if (certInfo.chainId !== CLEARSIGN_SCOPE_SOLANA) return false
  const preimage = buildLutAttestationPreimage(messageHash, accounts)
  const digest = createHash('sha256').update(preimage).digest('hex')
  const sig = hexBytes(lutSignatureHex, 64, 'lut signature')
  const r = `0x${sig.subarray(0, 32).toString('hex')}`
  const s = `0x${sig.subarray(32, 64).toString('hex')}`
  return [27, 28].some((v) => {
    try {
      const recovered = ethersUtils.recoverPublicKey(`0x${digest}`, { r, s, v })
      return ethersUtils.computePublicKey(recovered, true).slice(2).toLowerCase() === certInfo.delegatePublicKey
    } catch {
      return false
    }
  })
}
