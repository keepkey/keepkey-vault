import { createHash } from 'node:crypto'
import { utils as ethersUtils } from 'ethers'

import type { ClearSignAuditEvidence, ClearSignPromotionBundle, ClearSignPromotionReview } from '../shared/types'
import { inspectAlphaCertificate, CLEARSIGN_SCOPE_SOLANA } from './clearsign-alpha-ceremony'
import { compilePromotedClearSignArtifact } from './clearsign-artifact-compiler'

function exactHex(value: string, bytes: number | undefined, label: string): Buffer {
  const clean = String(value || '').replace(/^0x/i, '')
  if (!clean || clean.length % 2 || !/^[0-9a-f]+$/i.test(clean) || (bytes !== undefined && clean.length !== bytes * 2)) {
    throw new Error(`${label} is not valid${bytes === undefined ? '' : ` ${bytes}-byte`} hex`)
  }
  return Buffer.from(clean, 'hex')
}

function signatureMatches(digest: string, signature: Buffer, expectedPublicKey: string, recovery?: number): number {
  const candidates = recovery === undefined ? [27, 28] : [recovery]
  if (!candidates.every(value => value === 27 || value === 28)) throw new Error('recovery must be 27 or 28')
  const r = `0x${signature.subarray(0, 32).toString('hex')}`
  const s = `0x${signature.subarray(32).toString('hex')}`
  for (const v of candidates) {
    try {
      const recovered = ethersUtils.computePublicKey(ethersUtils.recoverPublicKey(`0x${digest}`, { r, s, v }), true).slice(2).toLowerCase()
      if (recovered === expectedPublicKey.toLowerCase()) return v
    } catch { /* try the other recovery bit */ }
  }
  throw new Error('artifact signature was not produced by the certified delegate')
}

export interface ClearSignArtifactCeremonyResult {
  bundleHash: string
  payloadHex: string
  signatureHex: string
  /** Required for EVM; optional for Solana because its protobuf carries compact signatures only. */
  recovery?: number
  certificateHex: string
}

export interface VerifiedClearSignArtifact {
  version: 1
  bundleHash: string
  shapeKey: string
  chain: ClearSignPromotionBundle['chain']
  identityHash: string
  expiresAt: number
  payloadHash: string
  payloadHex: string
  signatureHex: string
  certificateHex: string
  delegatePublicKey: string
  delegateAlias: string
  reviewerFingerprints: string[]
  importedAt: number
  /** Complete txMetadata payload for EVM; Solana transports the three components separately. */
  evmCertifiedEnvelopeHex?: string
  solana?: { schemaPayloadHex: string; schemaSignatureHex: string; signerKeyId: 128; certificateHex: string }
}

/** Verify an offline ceremony result. No signing key is accepted or available here. */
export function importPromotedClearSignArtifact(input: {
  bundle: ClearSignPromotionBundle
  reviews: ClearSignPromotionReview[]
  currentEvidence: ClearSignAuditEvidence
  observedShape: Record<string, unknown>
  ceremony: ClearSignArtifactCeremonyResult
  revoked?: boolean
  now?: number
}): VerifiedClearSignArtifact {
  const now = input.now ?? Date.now()
  const compiled = compilePromotedClearSignArtifact({
    bundle: input.bundle, reviews: input.reviews, currentEvidence: input.currentEvidence,
    observedShape: input.observedShape, revoked: input.revoked, now,
  })
  if (input.ceremony.bundleHash.replace(/^0x/i, '').toLowerCase() !== compiled.bundleHash) throw new Error('ceremony result targets a different promotion bundle')
  const payload = exactHex(input.ceremony.payloadHex, undefined, 'artifact payload')
  if (payload.toString('hex') !== compiled.payloadHex) throw new Error('ceremony payload differs from the deterministically compiled payload')
  const signature = exactHex(input.ceremony.signatureHex, 64, 'artifact signature')
  const certificate = exactHex(input.ceremony.certificateHex, 139, 'certificate')
  const cert = inspectAlphaCertificate(certificate.toString('hex'), Math.floor(now / 1000))
  // Bind to the chain encoded by the deterministic compiler, not the EVM family.
  const expectedScope = input.bundle.chain === 'Ethereum' ? payload.readUInt32BE(1) : CLEARSIGN_SCOPE_SOLANA
  if (cert.chainId !== expectedScope) throw new Error(`certificate scope ${cert.chainId} does not match ${input.bundle.chain}`)
  if (cert.notAfter * 1000 < input.bundle.expiresAt) throw new Error('certificate expires before the promoted artifact')
  const digest = createHash('sha256').update(Uint8Array.from(payload)).digest('hex')
  if (digest !== compiled.payloadHash) throw new Error('compiled payload hash mismatch')
  const recovery = signatureMatches(digest, signature, cert.delegatePublicKey, input.ceremony.recovery)
  const common = {
    version: 1 as const, bundleHash: compiled.bundleHash, shapeKey: input.bundle.shapeKey,
    chain: input.bundle.chain, identityHash: input.bundle.identityHash, expiresAt: input.bundle.expiresAt,
    payloadHash: digest, payloadHex: payload.toString('hex'), signatureHex: signature.toString('hex'),
    certificateHex: certificate.toString('hex'), delegatePublicKey: cert.delegatePublicKey,
    delegateAlias: cert.alias, reviewerFingerprints: compiled.reviewerFingerprints, importedAt: now,
  }
  if (input.bundle.chain === 'Ethereum') {
    if (input.ceremony.recovery === undefined) throw new Error('EVM artifact requires its recovery byte')
    return { ...common, evmCertifiedEnvelopeHex: Buffer.concat([
      Buffer.from([3]), certificate, payload, signature, Buffer.from([recovery]),
    ] as any).toString('hex') }
  }
  return { ...common, solana: {
    schemaPayloadHex: payload.toString('hex'), schemaSignatureHex: signature.toString('hex'),
    signerKeyId: 128, certificateHex: certificate.toString('hex'),
  } }
}
