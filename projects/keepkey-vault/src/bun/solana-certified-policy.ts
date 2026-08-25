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
