import { createHash } from 'node:crypto'
import type { ClearSignCentralAssetReview, ClearSignCentralContractReview } from '../shared/types'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export type UnsignedCentralAssetReview = Omit<ClearSignCentralAssetReview, 'signature'>

/** Exact statement format accepted by the production discovery worker. */
export function buildCentralAssetReview(input: {
  caip: string
  evidenceHash: string
  reviewerPublicKey: string
  role: ClearSignCentralAssetReview['role']
  decision: ClearSignCentralAssetReview['decision']
  reviewedAt?: number
}): { statement: UnsignedCentralAssetReview; digest: string; canonical: string } {
  const caip = String(input.caip || '').trim()
  const evidenceHash = String(input.evidenceHash || '').trim().toLowerCase()
  const reviewerPublicKey = String(input.reviewerPublicKey || '').trim().replace(/^0x/i, '').toLowerCase()
  const reviewedAt = input.reviewedAt ?? Date.now()
  if (caip.length < 3 || caip.length > 300) throw new Error('Invalid asset identity')
  if (!/^[0-9a-f]{64}$/.test(evidenceHash)) throw new Error('Invalid evidence hash')
  if (!/^(?:02|03)[0-9a-f]{64}$/.test(reviewerPublicKey)) throw new Error('Reviewer public key must be compressed secp256k1')
  if (!['semantics-review', 'security-review'].includes(input.role)) throw new Error('Invalid review role')
  if (!['approve', 'reject'].includes(input.decision)) throw new Error('Invalid review decision')
  if (!Number.isSafeInteger(reviewedAt) || reviewedAt < 1) throw new Error('Invalid review timestamp')
  const statement: UnsignedCentralAssetReview = {
    version: 1, caip, evidenceHash, reviewerPublicKey,
    role: input.role, decision: input.decision, reviewedAt,
  }
  const serialized = canonical({ domain: 'KEEPKEY_CLEARSIGN_ASSET_REVIEW_V1', ...statement })
  return { statement, digest: createHash('sha256').update(serialized).digest('hex'), canonical: serialized }
}

export function buildCentralContractReview(input: {
  auditId: string; evidenceHash: string; reviewerPublicKey: string
  role: ClearSignCentralContractReview['role']; decision: ClearSignCentralContractReview['decision']; reviewedAt?: number
}): { statement: Omit<ClearSignCentralContractReview, 'signature'>; digest: string; canonical: string } {
  const auditId = String(input.auditId || '').trim().toLowerCase()
  const evidenceHash = String(input.evidenceHash || '').trim().toLowerCase()
  const reviewerPublicKey = String(input.reviewerPublicKey || '').trim().replace(/^0x/i, '').toLowerCase()
  const reviewedAt = input.reviewedAt ?? Date.now()
  if (!/^[0-9a-f]{64}$/.test(auditId) || !/^[0-9a-f]{64}$/.test(evidenceHash)) throw new Error('Invalid contract audit binding')
  if (!/^(?:02|03)[0-9a-f]{64}$/.test(reviewerPublicKey)) throw new Error('Reviewer public key must be compressed secp256k1')
  if (!['semantics-review', 'security-review'].includes(input.role) || !['approve', 'reject'].includes(input.decision)) throw new Error('Invalid contract review')
  if (!Number.isSafeInteger(reviewedAt) || reviewedAt < 1) throw new Error('Invalid review timestamp')
  const statement = { version: 1 as const, auditId, evidenceHash, reviewerPublicKey,
    role: input.role, decision: input.decision, reviewedAt }
  const serialized = canonical({ domain: 'KEEPKEY_CLEARSIGN_DISCOVERY_REVIEW_V1', ...statement })
  return { statement, digest: createHash('sha256').update(serialized).digest('hex'), canonical: serialized }
}
