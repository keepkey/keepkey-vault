/**
 * Certified Solana LUT/schema proof, fetched from the isolated ClearSign
 * signer service per transaction. Mirrors evm-schema-registry.ts's
 * findCertifiedEvmSchema — same service, same "unavailable/no-match is not
 * an error" contract, same manufactures-no-trust-from-the-response shape.
 *
 * Unlike the EVM v3 envelope (one signed blob), the Solana certified path
 * always needs a reusable instruction schema and its certificate. Messages
 * that reference address lookup tables additionally need a transaction-bound
 * LUT account attestation. They come from one /v1/solana/certify call.
 */
import { CERTIFIED_SOLANA_CATALOG } from './solana-certified-schema'

/**
 * Release builds use KeepKey's production ClearSign service by default. Local
 * development can override it with CLEARSIGN_SERVICE_URL; either endpoint is
 * untrusted input and the device still verifies every certificate and proof.
 */
export const DEFAULT_CLEARSIGN_SERVICE_URL = 'https://keepkey-clearsign.bithighlander.workers.dev'

export interface CertifiedSolanaProof {
  /** Present only when the message actually references address lookup tables. */
  lutProof?: {
    accounts: string[] // base64, 32 bytes each
    signature: string // hex, no 0x prefix
    signerKeyId: number
  }
  schema: {
    payload: string // hex, no 0x prefix
    signature: string // hex, no 0x prefix
    signerKeyId: number
  }
  certificate: string // hex, no 0x prefix
}

function strip0x(value: string): string {
  return value.startsWith('0x') ? value.slice(2) : value
}

function requireHex(value: unknown, bytes: number | undefined, label: string): string {
  const hex = strip0x(String(value ?? ''))
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error(`ClearSign verification service returned invalid ${label}`)
  }
  if (bytes !== undefined && hex.length !== bytes * 2) {
    throw new Error(`ClearSign verification service returned invalid ${label} length`)
  }
  return hex
}

function requireAccount(value: unknown): string {
  const account = String(value ?? '')
  const decoded = Buffer.from(account, 'base64')
  // Buffer's decoder is intentionally permissive; round-trip the canonical
  // spelling so malformed text cannot silently decode to a different key.
  if (decoded.length !== 32 || decoded.toString('base64') !== account) {
    throw new Error('ClearSign verification service returned an invalid LUT account')
  }
  return account
}

/**
 * Ask the isolated signer service to certify this exact Solana transaction
 * against a reviewed catalog entry. Returns undefined (never throws for a
 * routine miss) when the service is unreachable, unconfigured, or the
 * instruction doesn't match any catalog entry — callers fall back to the
 * existing runtime-schema/consent path. Self-contained legacy/v0 messages
 * intentionally return a certified schema + certificate without `lutProof`;
 * manufacturing an empty lookup proof would conflate two different security
 * claims and is rejected by firmware.
 */
export async function findCertifiedSolanaProof(
  rawTxBase64: string,
  catalogKey: string,
): Promise<CertifiedSolanaProof | undefined> {
  if (!(catalogKey in CERTIFIED_SOLANA_CATALOG)) return undefined
  const base = String(process.env.CLEARSIGN_SERVICE_URL || DEFAULT_CLEARSIGN_SERVICE_URL)
    .trim()
    .replace(/\/+$/, '')

  let response: Response
  try {
    response = await fetch(`${base}/v1/solana/certify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rawTx: rawTxBase64, catalogKey }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error: any) {
    throw new Error(`ClearSign verification service is unavailable: ${error?.message || 'connection failed'}`)
  }
  let result: any
  try {
    result = await response.json()
  } catch {
    throw new Error(`ClearSign verification service returned HTTP ${response.status} without valid JSON`)
  }
  if (!response.ok) {
    if (response.status === 422) {
      console.log(`[swap] certified Solana proof declined (422): ${result?.error || 'no reason given'}`)
      return undefined
    }
    throw new Error(`ClearSign verification service returned HTTP ${response.status}: ${result?.error || 'request failed'}`)
  }
  if (
    result?.classification !== 'VERIFIED' ||
    !result?.schema?.payload ||
    !result?.schema?.signature ||
    !result?.certificate
  ) {
    throw new Error('ClearSign verification service returned an incomplete certified proof')
  }

  const hasAnyLutProof = result?.lutProof !== undefined
  if (hasAnyLutProof && (
    !result?.lutProof?.signature ||
    !Array.isArray(result?.lutProof?.accounts) ||
    result.lutProof.accounts.length === 0
  )) {
    throw new Error('ClearSign verification service returned a partial LUT proof')
  }

  if (result.schema.signerKeyId !== 0x80 ||
      (hasAnyLutProof && result.lutProof.signerKeyId !== 0x80)) {
    throw new Error('ClearSign verification service returned a non-certified signer id')
  }

  const schemaPayload = requireHex(result.schema.payload, undefined, 'schema payload')
  const schemaSignature = requireHex(result.schema.signature, 64, 'schema signature')
  const certificate = requireHex(result.certificate, 139, 'certificate')

  return {
    ...(hasAnyLutProof ? {
      lutProof: {
        accounts: result.lutProof.accounts.map(requireAccount),
        signature: requireHex(result.lutProof.signature, 64, 'LUT signature'),
        signerKeyId: result.lutProof.signerKeyId,
      },
    } : {}),
    schema: {
      payload: schemaPayload,
      signature: schemaSignature,
      signerKeyId: result.schema.signerKeyId,
    },
    certificate,
  }
}
