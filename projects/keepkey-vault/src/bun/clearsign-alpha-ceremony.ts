import { createHash } from 'node:crypto'
import { utils as ethersUtils } from 'ethers'

export const ALPHA_ROOT_PATH = [0x8000002c, 0x8000003c, 0x80000000, 0, 0]
/** The one ClearSign root Desktop trusts: the production root compiled into
 *  released 7.16 firmware. The alpha root lives in
 *  scripts/clearsign-alpha-rehearsal.ts and is never shipped. */
export const PRODUCTION_ROOT_PUBLIC_KEY = '027c1fde75db6c36393e095e0dc5ab9a5bcf1ae9eb92b5d36e212a2bf7f8a6e321'
export const CLEARSIGN_DOMAIN_SEPARATOR = '8839401f8d0112b4348770ddace152e96fc5e5081aefeed6b5d8bef0d6ecdf66'
export const CLEARSIGN_MIN_EXPIRY = 1787270400

/** scope_id values this build is allowed to request/verify a certificate for. */
export const CLEARSIGN_SCOPE_ETHEREUM = 1
export const CLEARSIGN_SCOPE_SOLANA = 501
export const CLEARSIGN_SCOPE_BASE = 8453
export const CLEARSIGN_SCOPE_ARBITRUM = 42161
// Firmware accepts any nonzero scope equal to the transaction's chain; this
// list is the host's own review gate for which chains a certificate may name.
export const CLEARSIGN_EVM_SCOPES = [1, 10, 56, 100, 130, 137, 5000, 8453, 42161, 42170, 43114, 80094, 81457] as const
const ALLOWED_SCOPES = new Set<number>([CLEARSIGN_SCOPE_SOLANA, ...CLEARSIGN_EVM_SCOPES])

const CERT_BODY_BYTES = 75
const CERT_SIGNATURE_BYTES = 64
const SECP256K1_HALF_ORDER = BigInt('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0')

/** First 4 bytes of sha256(compressed key), as the signer services and the
 *  event log name a delegate. */
export function delegateFingerprint(publicKeyHex: string): string {
  return createHash('sha256').update(exactHex(publicKeyHex, 33, 'delegate public key')).digest('hex').slice(0, 8)
}

function exactHex(input: string, bytes: number, label: string): Buffer {
  const value = String(input || '').replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]+$/.test(value) || value.length !== bytes * 2) {
    throw new Error(`${label} must be exactly ${bytes} bytes of hex`)
  }
  return Buffer.from(value, 'hex')
}

function decodeAlias(bytes: Buffer): string {
  const firstNul = bytes.indexOf(0)
  if (firstNul < 1 || firstNul > 31) throw new Error('certificate alias must be 1-31 NUL-padded ASCII bytes')
  for (let i = 0; i < firstNul; i++) {
    if (bytes[i] < 0x20 || bytes[i] > 0x7e) throw new Error('certificate alias contains non-printable ASCII')
  }
  for (let i = firstNul; i < bytes.length; i++) {
    if (bytes[i] !== 0) throw new Error('certificate alias has nonzero bytes after its NUL terminator')
  }
  return bytes.subarray(0, firstNul).toString('ascii')
}

function encodeAlias(alias: string): Buffer {
  const value = String(alias || '')
  const encoded = Buffer.from(value, 'ascii')
  if (encoded.length < 1 || encoded.length > 31 || encoded.toString('ascii') !== value) {
    throw new Error('certificate alias must be 1-31 printable ASCII characters')
  }
  for (const byte of encoded) {
    if (byte < 0x20 || byte > 0x7e) throw new Error('certificate alias contains non-printable ASCII')
  }
  const padded = Buffer.alloc(32)
  encoded.copy(padded)
  return padded
}

export interface AlphaCertificateBody {
  body: Buffer
  alias: string
  chainId: number
  notAfter: number
  delegatePublicKey: string
  messageHash: string
  signingDigest: string
}

/** Build the exact 75-byte body the root KeepKey reviews and signs. */
export function buildAlphaCertificateBody(
  alias: string,
  notAfter: number,
  scope: number,
  delegatePublicKey: string,
): { signedBodyHex: string; expectedMessageHashHex: string } {
  if (!Number.isSafeInteger(notAfter) || notAfter < 0 || notAfter > 0xffffffff) {
    throw new Error('certificate expiry must be a uint32 Unix timestamp')
  }
  if (!ALLOWED_SCOPES.has(scope)) throw new Error(`unsupported certificate scope ${scope}`)
  const body = Buffer.alloc(CERT_BODY_BYTES)
  body[0] = 1 // certificate version
  body[1] = 1 // MAY_SUPPRESS_RAW and no other capabilities
  body.writeUInt32BE(scope, 2)
  body.writeUInt32BE(notAfter, 6)
  encodeAlias(alias).copy(body, 10)
  exactHex(delegatePublicKey, 33, 'delegate public key').copy(body, 42)
  return {
    signedBodyHex: body.toString('hex'),
    expectedMessageHashHex: ethersUtils.keccak256(body).slice(2),
  }
}

/** Validate a certificate body: version, capability, a reviewed scope, expiry
 *  and the independently computed hash. Any delegate key may be named; the
 *  root signature (inspectAlphaCertificate) is what vouches for it. */
export function inspectAlphaCertificateBody(
  signedBodyHex: string,
  expectedMessageHashHex: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): AlphaCertificateBody {
  const body = exactHex(signedBodyHex, CERT_BODY_BYTES, 'signed certificate body')
  if (body[0] !== 1) throw new Error('certificate version must be 1')
  if (body[1] !== 1) throw new Error('certificate must grant exactly MAY_SUPPRESS_RAW')

  const chainId = body.readUInt32BE(2)
  if (!ALLOWED_SCOPES.has(chainId)) throw new Error(`certificate scope ${chainId} is not a reviewed scope`)
  const notAfter = body.readUInt32BE(6)
  if (notAfter <= CLEARSIGN_MIN_EXPIRY) throw new Error('certificate expiry does not clear the 7.16 revocation floor')
  if (notAfter <= nowSeconds) throw new Error('certificate is already expired')

  const alias = decodeAlias(body.subarray(10, 42))
  const delegatePublicKey = body.subarray(42, 75).toString('hex')

  const messageHash = ethersUtils.keccak256(body).slice(2)
  const expectedMessageHash = exactHex(expectedMessageHashHex, 32, 'independent message hash').toString('hex')
  if (messageHash !== expectedMessageHash) throw new Error('independent message hash does not match the certificate body')
  const signingDigest = ethersUtils.keccak256(ethersUtils.concat([
    '0x1901',
    `0x${CLEARSIGN_DOMAIN_SEPARATOR}`,
    `0x${messageHash}`,
  ])).slice(2)

  return { body, alias, chainId, notAfter, delegatePublicKey, messageHash, signingDigest }
}

export function verifyAlphaRootSignature(
  inspection: AlphaCertificateBody,
  signatureHex: string,
  rootPublicKey: string = PRODUCTION_ROOT_PUBLIC_KEY,
): { certificateHex: string; address: string } {
  const raw = exactHex(signatureHex, 65, 'device signature')
  const recovery = raw[64]
  if (recovery !== 27 && recovery !== 28) throw new Error('device signature recovery byte must be 27 or 28')
  const s = BigInt(`0x${raw.subarray(32, 64).toString('hex')}`)
  if (s > SECP256K1_HALF_ORDER) throw new Error('device returned a non-canonical high-S signature')

  const recovered = ethersUtils.recoverPublicKey(`0x${inspection.signingDigest}`, `0x${raw.toString('hex')}`)
  const compressed = ethersUtils.computePublicKey(recovered, true).slice(2).toLowerCase()
  if (compressed !== rootPublicKey) throw new Error('signature was not produced by the expected ClearSign root')

  return {
    certificateHex: Buffer.concat([inspection.body, raw.subarray(0, CERT_SIGNATURE_BYTES)]).toString('hex'),
    address: ethersUtils.computeAddress(`0x${rootPublicKey}`),
  }
}

/** Validate a complete 139-byte certificate against the production root.
 *  Only rehearsals and tests pass another root. */
export function inspectAlphaCertificate(
  certificateHex: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  rootPublicKey: string = PRODUCTION_ROOT_PUBLIC_KEY,
): AlphaCertificateBody {
  const certificate = exactHex(certificateHex, CERT_BODY_BYTES + CERT_SIGNATURE_BYTES, 'certificate')
  const body = certificate.subarray(0, CERT_BODY_BYTES)
  const inspection = inspectAlphaCertificateBody(
    body.toString('hex'),
    ethersUtils.keccak256(body).slice(2),
    nowSeconds,
  )
  const compact = certificate.subarray(CERT_BODY_BYTES)
  const r = `0x${compact.subarray(0, 32).toString('hex')}`
  const s = `0x${compact.subarray(32, 64).toString('hex')}`
  const matchesRoot = [27, 28].some((v) => {
    try {
      return ethersUtils.computePublicKey(
        ethersUtils.recoverPublicKey(`0x${inspection.signingDigest}`, { r, s, v }),
        true,
      ).slice(2).toLowerCase() === rootPublicKey
    } catch {
      return false
    }
  })
  if (!matchesRoot) throw new Error('certificate was not signed by the KeepKey ClearSign root')
  return inspection
}
