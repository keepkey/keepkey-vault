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
import bs58 from 'bs58'
import { CERTIFIED_SOLANA_CATALOG, serializeSolanaSchema } from './solana-certified-schema'
import { certifiedSolanaSchemaApplies, findLocalCertifiedSolanaMatch } from './solana-certified-match'
import { hasCompleteCertifiedSolanaEnvelope, supportsCertifiedClearSign } from './solana-certified-policy'
import { applySolanaSigningGates, requiresSolanaBlindSigningConsent } from './solana-consent'
import { parseSolanaMessage, parseSolanaTx, solanaMessageSlice, type ParsedSolanaMessage } from './solana-tx'
import type { SigningRequestInfo, SolanaTxDecodedInfo } from '../shared/types'

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
  /** Delegate-attested on-chain identity of mints the schema shows amounts
   * in. Firmware verifies each against the certificate; without one it shows
   * the raw amount and the full mint address. */
  tokenInfo?: Array<{
    mint: string // base58
    symbol: string
    decimals: number
    signature: string // hex, no 0x prefix
    signerKeyId: number
  }>
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

/** SolanaSignTx.token_info max_count in firmware. */
const MAX_TOKEN_INFO = 4

function requireTokenInfo(value: any): NonNullable<CertifiedSolanaProof['tokenInfo']>[number] {
  let mint: Uint8Array | undefined
  try { mint = bs58.decode(String(value?.mint ?? '')) } catch { /* rejected below */ }
  if (
    mint?.length !== 32 ||
    typeof value.symbol !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$/.test(value.symbol) ||
    !Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 9 ||
    value.signerKeyId !== 0x80
  ) {
    throw new Error('ClearSign verification service returned invalid token identity')
  }
  return {
    mint: String(value.mint),
    symbol: value.symbol,
    decimals: value.decimals,
    signature: requireHex(value.signature, 64, 'token signature'),
    signerKeyId: 0x80,
  }
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
  /** Omit to let the service match the transaction against the whole catalog. */
  catalogKey?: string,
): Promise<CertifiedSolanaProof | undefined> {
  if (catalogKey !== undefined && !Object.prototype.hasOwnProperty.call(CERTIFIED_SOLANA_CATALOG, catalogKey)) return undefined
  const base = String(process.env.CLEARSIGN_SERVICE_URL || DEFAULT_CLEARSIGN_SERVICE_URL)
    .trim()
    .replace(/\/+$/, '')

  let response: Response
  try {
    response = await fetch(`${base}/v1/solana/certify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(catalogKey === undefined ? { rawTx: rawTxBase64 } : { rawTx: rawTxBase64, catalogKey }),
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
  if (result.tokenInfo !== undefined && (
    !Array.isArray(result.tokenInfo) || result.tokenInfo.length === 0 || result.tokenInfo.length > MAX_TOKEN_INFO
  )) {
    throw new Error('ClearSign verification service returned invalid token metadata')
  }
  const tokenInfo = result.tokenInfo?.map(requireTokenInfo)

  return {
    ...(tokenInfo ? { tokenInfo } : {}),
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

/**
 * Whether the device will apply a certified envelope to this transaction:
 * its schema is the reviewed payload of `catalogKey`, and the firmware's
 * certified rule holds with the envelope's LUT proof. Otherwise the device
 * refuses the whole request ("Certified Solana schema does not match
 * transaction") with no fallback, while the opaque path could still sign.
 */
export function certifiedSolanaProofApplies(rawTxBase64: string, catalogKey: string, proof: CertifiedSolanaProof): boolean {
  const spec = CERTIFIED_SOLANA_CATALOG[catalogKey]
  if (!spec || proof.schema.payload.toLowerCase() !== serializeSolanaSchema(spec).toString('hex')) return false
  let message: ParsedSolanaMessage
  try {
    const fullTx = Uint8Array.from(Buffer.from(rawTxBase64, 'base64'))
    message = parseSolanaMessage(solanaMessageSlice(fullTx, parseSolanaTx(fullTx)))
  } catch {
    return false
  }
  return certifiedSolanaSchemaApplies(message, spec, proof.lutProof?.accounts.length ?? 0) !== undefined
}

/**
 * External REST callers (dapps) almost never send certified material. Before
 * the approval window opens, look for a reviewed catalog entry this exact
 * transaction certifies under. Only for firmware that verifies certified
 * schemas, and only when the caller supplied none of its own (caller material
 * is forwarded to the device unchanged instead).
 *
 * Privacy: the match runs locally first, under the firmware's certified rule
 * (solana-certified-match.ts). A transaction that matches no entry never
 * leaves this machine; one that does is sent with that entry's catalogKey.
 *
 * The envelope is accepted only when the device will apply it: its schema is
 * the reviewed payload the local rule was checked against, and the rule still
 * holds with its LUT proof, which needs exactly one key per serialized LUT
 * index (no proof without lookup tables). Otherwise the device
 * would refuse it with no fallback, while the opaque path can still sign.
 *
 * Never throws: no local match, an unavailable service, a 422 no-match, or
 * unusable material all return undefined, and the caller keeps the existing
 * opaque path. Nothing returned here is trusted; firmware verifies all of it.
 */
export async function prepareExternalSolanaProof(
  body: { raw_tx?: unknown; schema?: unknown; lutProof?: unknown; certificate?: unknown },
  firmwareVersion: string | undefined,
): Promise<CertifiedSolanaProof | undefined> {
  if (
    !supportsCertifiedClearSign(firmwareVersion) || typeof body.raw_tx !== 'string' ||
    body.schema !== undefined || body.lutProof !== undefined || body.certificate !== undefined
  ) {
    return undefined
  }
  let message: ParsedSolanaMessage
  try {
    const fullTx = Uint8Array.from(Buffer.from(body.raw_tx, 'base64'))
    message = parseSolanaMessage(solanaMessageSlice(fullTx, parseSolanaTx(fullTx)))
  } catch {
    return undefined
  }
  const match = findLocalCertifiedSolanaMatch(message)
  if (!match) return undefined

  let proof: CertifiedSolanaProof | undefined
  try {
    proof = await findCertifiedSolanaProof(body.raw_tx, match.catalogKey)
  } catch (error: any) {
    console.warn(`[REST] certified Solana ClearSign lookup unavailable: ${error?.message || error}`)
    return undefined
  }
  if (!proof || !hasCompleteCertifiedSolanaEnvelope(proof) || !certifiedSolanaProofApplies(body.raw_tx, match.catalogKey, proof)) {
    return undefined
  }
  return proof
}

/**
 * Pre-approval routing for REST /solana/sign-transaction. A transaction the
 * firmware already clear-signs (or that carries caller metadata) never
 * reaches the service. Otherwise a certified envelope the device will apply
 * replaces the opaque path: no one-shot consent and no AdvancedMode, because
 * the device decodes and verifies it. No envelope keeps the opaque path.
 */
export async function routeExternalSolanaTransaction(
  decoded: SolanaTxDecodedInfo | undefined,
  body: { raw_tx?: unknown; schema?: unknown; lutProof?: unknown; certificate?: unknown },
  firmwareVersion: string | undefined,
): Promise<{ requiresBlindSigningConsent: boolean; certifiedProof?: CertifiedSolanaProof }> {
  const callerMetadata = body.lutProof !== undefined || body.schema !== undefined
  if (!requiresSolanaBlindSigningConsent(decoded, callerMetadata)) {
    return { requiresBlindSigningConsent: false }
  }
  const certifiedProof = await prepareExternalSolanaProof(body, firmwareVersion)
  return certifiedProof
    ? { requiresBlindSigningConsent: false, certifiedProof }
    : { requiresBlindSigningConsent: true }
}

/**
 * The approval gates for REST /solana/sign-transaction. Route first, then
 * judge AdvancedMode on the material the device will receive: the certified
 * envelope when one was found (the device verifies it and needs neither
 * consent nor AdvancedMode), otherwise the caller's own. Judging the caller's
 * material alone would demand AdvancedMode for a transaction the device
 * clear-signs from the envelope. Returns the envelope to forward at sign time.
 */
export async function applyRestSolanaSigningGates(
  info: SigningRequestInfo,
  body: { raw_tx?: unknown; schema?: any; lutProof?: any; certificate?: any },
  firmwareVersion: string | undefined,
): Promise<CertifiedSolanaProof | undefined> {
  const route = await routeExternalSolanaTransaction(info.solanaDecoded, body, firmwareVersion)
  applySolanaSigningGates(
    info,
    typeof body.raw_tx === 'string' ? body.raw_tx : undefined,
    firmwareVersion,
    route.certifiedProof ?? { lutProof: body.lutProof, schema: body.schema, certificate: body.certificate },
  )
  return route.certifiedProof
}

/**
 * The SolanaSignTx request for REST /solana/sign-transaction, after approval.
 * Caller material (schema, LUT proof, certificate) is forwarded unchanged and
 * wins. Otherwise the preview's certified envelope is forwarded, but only for
 * the exact raw_tx it was found for.
 *
 * `routedCertified` means the approval window told the user the device
 * decodes this transaction and asked for no opaque-signing consent. If no
 * certified material reaches the device then, it would get an opaque
 * transaction the user never consented to, so this refuses instead.
 */
export function buildRestSolanaSignRequest(
  body: {
    raw_tx: string
    schema?: { payload: string; signature: string; signerKeyId: number }
    lutProof?: unknown
    certificate?: string
    x402?: unknown
  },
  addressNList: number[],
  approval: {
    certified?: { rawTx: string; proof: CertifiedSolanaProof }
    routedCertified: boolean
    allowBlindSigning: boolean
  },
) {
  const callerMaterial = body.schema !== undefined || body.lutProof !== undefined || body.certificate !== undefined
  const certified = !callerMaterial && approval.certified?.rawTx === body.raw_tx ? approval.certified.proof : undefined
  const schema = callerMaterial ? body.schema : certified?.schema
  const certificate = callerMaterial ? body.certificate : certified?.certificate
  if (approval.routedCertified && !(schema && certificate)) {
    throw Object.assign(
      new Error('Certified Solana ClearSign material is missing at signing time; refusing to sign an opaque transaction without consent'),
      { status: 409 },
    )
  }
  return {
    addressNList,
    rawTx: body.raw_tx,
    lutProof: callerMaterial ? body.lutProof : certified?.lutProof,
    certificate,
    // Reusable KKSOLSC1 instruction schema: signed once per program and
    // instruction, so the device decodes this call without a per-transaction
    // attestation.
    schema,
    // Attested mint identities for the schema's token amounts. x402
    // metadata, when present, replaces this in the signing helper.
    ...(certified?.tokenInfo ? { tokenInfo: certified.tokenInfo } : {}),
    // x402 payment intent is never trusted directly: the signing helper
    // matches network, sponsor, mint, amount, authority and destination ATA
    // against the exact v0 message first.
    x402: body.x402,
    allowBlindSigning: approval.allowBlindSigning,
  }
}
