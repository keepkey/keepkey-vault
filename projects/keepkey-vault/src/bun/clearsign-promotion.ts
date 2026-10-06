import { createHash } from 'node:crypto'
import { utils as ethersUtils } from 'ethers'

import type {
  ClearSignAuditEvidence,
  ClearSignMutationKind,
  ClearSignPromotionBundle,
  ClearSignPromotionReview,
  ClearSignPromotionVerdict,
} from '../shared/types'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function clearSignIdentityHash(evidence: ClearSignAuditEvidence): string {
  return createHash('sha256').update(canonical(evidence.identities)).digest('hex')
}

export function clearSignPromotionBundleHash(bundle: ClearSignPromotionBundle): string {
  return createHash('sha256').update(canonical(bundle)).digest('hex')
}

export function clearSignPromotionReviewDigest(review: Omit<ClearSignPromotionReview, 'signature'>): string {
  return createHash('sha256').update(canonical({
    domain: 'KEEPKEY_CLEARSIGN_PROMOTION_REVIEW_V1',
    bundleHash: review.bundleHash.toLowerCase().replace(/^0x/, ''),
    reviewerPublicKey: review.reviewerPublicKey.toLowerCase().replace(/^0x/, ''),
    role: review.role,
    decision: review.decision,
    reviewedAt: review.reviewedAt,
  })).digest('hex')
}

function normalizedPublicKey(value: string): string | undefined {
  try { return ethersUtils.computePublicKey(value.startsWith('0x') ? value : `0x${value}`, true).slice(2).toLowerCase() } catch { return undefined }
}

export function verifyClearSignPromotionReview(bundle: ClearSignPromotionBundle, review: ClearSignPromotionReview): boolean {
  const bundleHash = clearSignPromotionBundleHash(bundle)
  if (review.bundleHash.toLowerCase().replace(/^0x/, '') !== bundleHash) return false
  try {
    const { signature: _signature, ...statement } = review
    const digest = clearSignPromotionReviewDigest(statement)
    const recovered = ethersUtils.recoverPublicKey(`0x${digest}`, review.signature.startsWith('0x') ? review.signature : `0x${review.signature}`)
    return normalizedPublicKey(recovered) === normalizedPublicKey(review.reviewerPublicKey)
  } catch { return false }
}

const REQUIRED_MUTATIONS: Record<ClearSignPromotionBundle['chain'], ClearSignMutationKind[]> = {
  Ethereum: ['truncation', 'selector-or-discriminator', 'field-boundary', 'chain-or-contract'],
  Solana: ['truncation', 'selector-or-discriminator', 'field-boundary', 'account-privilege'],
}

/** Deterministic fail-closed promotion gate. This evaluates evidence; it never signs or publishes. */
export function evaluateClearSignPromotion(input: {
  bundle: ClearSignPromotionBundle
  reviews: ClearSignPromotionReview[]
  currentEvidence: ClearSignAuditEvidence
  revokedBundleHashes?: string[]
  now?: number
}): ClearSignPromotionVerdict {
  const { bundle, currentEvidence } = input
  const now = input.now ?? Date.now()
  const bundleHash = clearSignPromotionBundleHash(bundle)
  const failures: string[] = []
  if (bundle.expiresAt <= now) failures.push('BUNDLE_EXPIRED')
  if (bundle.expiresAt <= bundle.createdAt) failures.push('INVALID_EXPIRY')
  if (input.revokedBundleHashes?.some((hash) => hash.toLowerCase().replace(/^0x/, '') === bundleHash)) failures.push('BUNDLE_REVOKED')
  if (bundle.identityHash !== clearSignIdentityHash(currentEvidence)) failures.push('CODE_IDENTITY_CHANGED')
  if (bundle.fixtures.length < 1) failures.push('NO_POSITIVE_FIXTURE')
  if (!bundle.deviceOracle.passed || !/^[0-9a-f]{64}$/i.test(bundle.deviceOracle.transcriptHash) || !/^[0-9a-f]{64}$/i.test(bundle.deviceOracle.artifactHash)) failures.push('DEVICE_ORACLE_MISSING')
  for (const kind of REQUIRED_MUTATIONS[bundle.chain]) {
    const mutation = bundle.mutations.find((entry) => entry.kind === kind)
    if (!mutation) failures.push(`MUTATION_MISSING:${kind}`)
    else if (mutation.observed === 'unexpected-pass' || mutation.observed !== mutation.expected) failures.push(`MUTATION_FAILED:${kind}`)
  }

  const valid = input.reviews.filter((review) =>
    review.reviewedAt >= bundle.createdAt
    && review.reviewedAt <= bundle.expiresAt
    && review.reviewedAt <= now
    && verifyClearSignPromotionReview(bundle, review))
  if (valid.some((review) => review.decision === 'reject')) failures.push('REVIEW_REJECTED')
  const approvals = valid.filter((review) => review.decision === 'approve')
  const keys = [...new Set(approvals.map((review) => normalizedPublicKey(review.reviewerPublicKey)).filter((key): key is string => Boolean(key)))]
  const roles = new Set(approvals.map((review) => review.role))
  if (keys.length < 2) failures.push('TWO_DISTINCT_REVIEWERS_REQUIRED')
  if (!roles.has('semantics-review') || !roles.has('security-review')) failures.push('BOTH_REVIEW_ROLES_REQUIRED')
  return {
    bundleHash,
    publishable: failures.length === 0,
    failures: [...new Set(failures)],
    reviewerFingerprints: keys.map((key) => createHash('sha256').update(Buffer.from(key, 'hex')).digest('hex').slice(0, 16)),
  }
}
