import { utils as ethersUtils } from 'ethers'

export const ALPHA_ROOT_PATH = [0x8000002c, 0x8000003c, 0x80000000, 0, 0]
export const ALPHA_ROOT_PUBLIC_KEY = '02de9231b2094433235532fb1932e324a2c7304195e12e610c675cccbbd606dae7'
export const ALPHA_DELEGATE_PUBLIC_KEY = '0342f5f9704494b3f9bd72295eecaf29d783d23ea02b2dc9f48abcd2e46d4850cf'
export const ALPHA_DELEGATE_FINGERPRINT = 'a9531b9d'
export const CLEARSIGN_DOMAIN_SEPARATOR = '8839401f8d0112b4348770ddace152e96fc5e5081aefeed6b5d8bef0d6ecdf66'
export const CLEARSIGN_MIN_EXPIRY = 1787270400

/** scope_id values this build is allowed to request/verify a certificate for. */
export const CLEARSIGN_SCOPE_ETHEREUM = 1
export const CLEARSIGN_SCOPE_SOLANA = 501
const ALLOWED_SCOPES = new Set([CLEARSIGN_SCOPE_ETHEREUM, CLEARSIGN_SCOPE_SOLANA])

const CERT_BODY_BYTES = 75
const CERT_SIGNATURE_BYTES = 64
const SECP256K1_HALF_ORDER = BigInt('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0')

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
  scope: number = CLEARSIGN_SCOPE_ETHEREUM,
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
  exactHex(ALPHA_DELEGATE_PUBLIC_KEY, 33, 'alpha delegate public key').copy(body, 42)
  return {
    signedBodyHex: body.toString('hex'),
    expectedMessageHashHex: ethersUtils.keccak256(body).slice(2),
  }
}

/** Validate the one alpha certificate this Vault build is allowed to request. */
export function inspectAlphaCertificateBody(
  signedBodyHex: string,
  expectedMessageHashHex: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): AlphaCertificateBody {
  const body = exactHex(signedBodyHex, CERT_BODY_BYTES, 'signed certificate body')
  if (body[0] !== 1) throw new Error('certificate version must be 1')
  if (body[1] !== 1) throw new Error('alpha certificate must grant exactly MAY_SUPPRESS_RAW')

  const chainId = body.readUInt32BE(2)
  if (!ALLOWED_SCOPES.has(chainId)) throw new Error(`certificate scope ${chainId} is not a reviewed alpha scope`)
  const notAfter = body.readUInt32BE(6)
  if (notAfter <= CLEARSIGN_MIN_EXPIRY) throw new Error('certificate expiry does not clear the 7.16 revocation floor')
  if (notAfter <= nowSeconds) throw new Error('certificate is already expired')

  const alias = decodeAlias(body.subarray(10, 42))
  const delegatePublicKey = body.subarray(42, 75).toString('hex')
  if (delegatePublicKey !== ALPHA_DELEGATE_PUBLIC_KEY) {
    throw new Error(`certificate delegate must be the reviewed alpha signer ${ALPHA_DELEGATE_FINGERPRINT}`)
  }

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
): { certificateHex: string; address: string } {
  const raw = exactHex(signatureHex, 65, 'device signature')
  const recovery = raw[64]
  if (recovery !== 27 && recovery !== 28) throw new Error('device signature recovery byte must be 27 or 28')
  const s = BigInt(`0x${raw.subarray(32, 64).toString('hex')}`)
  if (s > SECP256K1_HALF_ORDER) throw new Error('device returned a non-canonical high-S signature')

  const recovered = ethersUtils.recoverPublicKey(`0x${inspection.signingDigest}`, `0x${raw.toString('hex')}`)
  const compressed = ethersUtils.computePublicKey(recovered, true).slice(2).toLowerCase()
  if (compressed !== ALPHA_ROOT_PUBLIC_KEY) throw new Error('signature was not produced by the reviewed alpha root')

  return {
    certificateHex: Buffer.concat([inspection.body, raw.subarray(0, CERT_SIGNATURE_BYTES)]).toString('hex'),
    address: ethersUtils.computeAddress(`0x${ALPHA_ROOT_PUBLIC_KEY}`),
  }
}

/** Validate a complete 139-byte certificate before it is given to a signer. */
export function inspectAlphaCertificate(
  certificateHex: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): AlphaCertificateBody {
  const certificate = exactHex(certificateHex, CERT_BODY_BYTES + CERT_SIGNATURE_BYTES, 'alpha certificate')
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
      ).slice(2).toLowerCase() === ALPHA_ROOT_PUBLIC_KEY
    } catch {
      return false
    }
  })
  if (!matchesRoot) throw new Error('certificate was not signed by the reviewed alpha root')
  return inspection
}
