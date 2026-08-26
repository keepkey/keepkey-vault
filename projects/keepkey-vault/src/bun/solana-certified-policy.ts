import { versionCompare } from '../shared/firmware-versions'

export const CERTIFIED_CLEARSIGN_MIN_FW = '7.16.0'

/** Certified signer id 0x80 did not exist before 7.16. Unknown versions are
 * treated as unsupported so Vault never sends an older device new authority
 * material and then mistakes its refusal for user cancellation. */
export function supportsCertifiedClearSign(firmwareVersion?: string): boolean {
  return !!firmwareVersion && versionCompare(firmwareVersion, CERTIFIED_CLEARSIGN_MIN_FW) >= 0
}

/**
 * Host routing predicate only. Cryptographic and transaction-shape validation
 * remains the device's job; this merely prevents Vault from demanding blind
 * signing when it has the complete root-certified schema envelope.
 */
export function hasCompleteCertifiedSolanaEnvelope(value: any): boolean {
  if (
    !value?.schema?.payload ||
    !value.schema.signature ||
    value.schema.signerKeyId !== 0x80 ||
    !value.certificate
  ) {
    return false
  }
  return value.lutProof === undefined || (
    Array.isArray(value.lutProof.accounts) &&
    value.lutProof.accounts.length > 0 &&
    !!value.lutProof.signature &&
    value.lutProof.signerKeyId === 0x80
  )
}
