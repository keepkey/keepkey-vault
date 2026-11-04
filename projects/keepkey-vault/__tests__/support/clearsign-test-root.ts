/**
 * A ClearSign TEST root for unit tests. Desktop attaches a certified envelope
 * only when it verifies to the root the device trusts, so tests that serve
 * one sign it here and trust this root for the test. The keys come from
 * fixed public strings: they are not secret and never a real root.
 */
import { createHash } from 'node:crypto'
import { utils as ethersUtils } from 'ethers'
import { buildAlphaCertificateBody, inspectAlphaCertificateBody } from '../../src/bun/clearsign-alpha-ceremony'
import { configureProductionRootTrust } from '../../src/shared/certified-evm-envelope'

const testKey = (label: string) => new ethersUtils.SigningKey(ethersUtils.keccak256(ethersUtils.toUtf8Bytes(label)))
const ROOT = testKey('keepkey-vault unit tests: ClearSign TEST root, not a real key')
const DELEGATE = testKey('keepkey-vault unit tests: ClearSign TEST delegate, not a real key')
const compressed = (key: InstanceType<typeof ethersUtils.SigningKey>) => ethersUtils.computePublicKey(key.publicKey, true).slice(2).toLowerCase()

export const TEST_ROOT_PUBLIC_KEY = compressed(ROOT)
/** The root of the ERC-7730 replay fixtures (erc7730-resolver.fixtures.json). */
export const ERC7730_FIXTURE_ROOT_PUBLIC_KEY = '02ec4954d2a274a8e8f05823471464dde86b675fbc675ddbb672a28c6953d9ef76'

/** Trust `root` (an emulator TEST root) until the returned function runs. */
export function trustTestRoot(root: string = TEST_ROOT_PUBLIC_KEY): () => void {
  configureProductionRootTrust(() => true, () => root)
  return () => configureProductionRootTrust(() => true)
}

/** A 139-byte certificate (hex) from the TEST root for `chainId`. */
export function testCertificate(chainId: number): string {
  const { signedBodyHex, expectedMessageHashHex } = buildAlphaCertificateBody('KeepKey TEST', 4_000_000_000, chainId, compressed(DELEGATE))
  const { signingDigest } = inspectAlphaCertificateBody(signedBodyHex, expectedMessageHashHex)
  const signature = ROOT.signDigest(`0x${signingDigest}`)
  return `${signedBodyHex}${signature.r.slice(2)}${signature.s.slice(2)}`
}

/** 0x03 | TEST certificate for the body's chain | body | delegate signature: a
 *  certified envelope that verifies under TEST_ROOT_PUBLIC_KEY. */
export function testCertifiedEnvelope(bodyHex: string): string {
  const body = Buffer.from(bodyHex.replace(/^0x/i, ''), 'hex')
  const signature = DELEGATE.signDigest(`0x${createHash('sha256').update(Uint8Array.from(body)).digest('hex')}`)
  const v = (27 + (signature.recoveryParam ?? 0)).toString(16)
  return `0x03${testCertificate(body.readUInt32BE(1))}${body.toString('hex')}${signature.r.slice(2)}${signature.s.slice(2)}${v}`
}

/** The same envelope, its certificate and signature replaced by TEST ones. */
export function testSigned(signedPayload: string): string {
  const hex = signedPayload.replace(/^0x/i, '')
  return testCertifiedEnvelope(hex.slice(2 + 278, hex.length - 130))
}
