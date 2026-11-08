import { createHash } from 'node:crypto'
import { utils as ethersUtils } from 'ethers'

import type { EvmSchemaSpec } from './evm-certified-schema'
import type { ClearSignDefinitionReview, ContractRating } from '../shared/clearsign-report'
import { DEFAULT_CLEARSIGN_SERVICE_URL } from './solana-certified-registry'

/**
 * Two separate things from the ClearSign service, verified separately:
 * - a definition review: two EIP-712 approvals of the clearsign definition
 *   (the device schema for one audited deployment). It decides whether the
 *   call clearsigns.
 * - a contract rating: an attributed assessment hosted by the service.
 *   Shown by this app only; it never reaches the device and never decides
 *   whether a call clearsigns.
 *
 * EIP-712 domain and types must match keepkey-clearsign-server
 * worker/src/attestation.ts exactly.
 */

/** Definition approvers this Vault trusts, by address. Empty until the key
 * ceremony: approvals then verify but show as unpinned. Once populated, any
 * other signer is refused. */
export const PINNED_APPROVERS: Record<string, Array<'semantics-review' | 'security-review'>> = {}

const DOMAIN = { name: 'KeepKey ClearSign', version: '1' }
const DEFINITION_APPROVAL_TYPES = {
  DefinitionApproval: [
    { name: 'auditId', type: 'bytes32' }, { name: 'evidenceHash', type: 'bytes32' },
    { name: 'role', type: 'string' }, { name: 'decision', type: 'string' }, { name: 'reviewedAt', type: 'uint64' },
  ],
}
const RISK_LEVELS = ['low', 'medium', 'high', 'critical']
const MAX_CLOCK_SKEW_MS = 5 * 60_000

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
const sha = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const hex32 = (value: string) => `0x${String(value).replace(/^0x/i, '').toLowerCase()}`

function signer(types: Record<string, Array<{ name: string; type: string }>>, message: Record<string, unknown>, signature: string) {
  return ethersUtils.verifyTypedData(DOMAIN, types, message, `0x${String(signature).replace(/^0x/i, '')}`).toLowerCase()
}

const DEPLOYMENT_ROLES = ['contract', 'implementation', 'beacon']

function deploymentIdentities(identities: any): Array<{ role: string; address: string; codeHash: string }> {
  return (Array.isArray(identities) ? identities : [])
    .filter((item: any) => DEPLOYMENT_ROLES.includes(item?.role))
    .map((item: any) => ({ role: String(item.role), address: String(item.address).toLowerCase(), codeHash: String(item.codeHash || '').toLowerCase() }))
}

/** Compare a deployment as audited/rated with the deployment as measured now.
 * Returns why they differ, or undefined when they are the same code. */
export function deploymentMismatch(audited: Array<{ role: string; address: string; codeHash: string }>, live: unknown): string | undefined {
  const now = deploymentIdentities(live)
  if (!now.length || now.some((item) => !/^0x[0-9a-f]{64}$/.test(item.codeHash))) return 'the contract has no deployed code to compare'
  const key = (item: { role: string; address: string; codeHash: string }) => `${item.role} ${item.address} ${item.codeHash}`
  const was = new Set(deploymentIdentities(audited).map(key)), is = new Set(now.map(key))
  const changed = [...is].filter((entry) => !was.has(entry)).concat([...was].filter((entry) => !is.has(entry)))
  if (!changed.length) return undefined
  const roles = [...new Set(changed.map((entry) => entry.split(' ')[0]))].join(', ')
  return `the deployed ${roles} changed since the audit`
}

/**
 * Verify a published definition review before its envelope is used. Proves:
 * the evidence hashes to what both approvals signed; the approvals are
 * EIP-712 DefinitionApprovals from two distinct addresses holding the
 * semantics and security roles; the definition describes exactly this call.
 * The caller must still bind the schema to the envelope bytes and check the
 * live deployment against `auditedIdentities`.
 */
export function verifyPublishedReview(review: any, shape: { chainId: number; contract: string; selector: string; calldataLength: number },
  pinned = PINNED_APPROVERS): { spec: EvmSchemaSpec; review: ClearSignDefinitionReview } {
  const evidence = review?.evidence
  const evidenceHash = String(review?.evidenceHash || '')
  if (!evidence || !/^[0-9a-f]{64}$/.test(evidenceHash) || sha(evidence) !== evidenceHash) {
    throw new Error('ClearSign review evidence does not match its hash')
  }
  const roles = new Map<string, string>()
  for (const approval of Array.isArray(review.approvals) ? review.approvals : []) {
    const statement = approval?.statement || {}
    const reviewer = String(statement.reviewer || '').toLowerCase()
    if (statement.version !== 1 || statement.decision !== 'approve' || statement.auditId !== review.auditId
      || statement.evidenceHash !== evidenceHash || statement.role !== approval.role || reviewer !== String(approval.reviewer).toLowerCase()
      || !['semantics-review', 'security-review'].includes(statement.role) || !Number.isSafeInteger(statement.reviewedAt)) {
      throw new Error('ClearSign review approval is not bound to this evidence')
    }
    const message = { auditId: hex32(statement.auditId), evidenceHash: hex32(statement.evidenceHash), role: statement.role,
      decision: statement.decision, reviewedAt: statement.reviewedAt }
    if (signer(DEFINITION_APPROVAL_TYPES, message, approval.signature) !== reviewer) {
      throw new Error('ClearSign review approval signature is invalid')
    }
    roles.set(statement.role, reviewer)
  }
  const semantics = roles.get('semantics-review'), security = roles.get('security-review')
  if (!semantics || !security || semantics === security) throw new Error('ClearSign review lacks two distinct approvals')
  const approversPinned = Boolean(pinned[semantics]?.includes('semantics-review') && pinned[security]?.includes('security-review'))
  if (Object.keys(pinned).length && !approversPinned) throw new Error('ClearSign review is signed by approvers this Vault does not trust')

  const spec = evidence.definition?.schema as EvmSchemaSpec | undefined
  if (evidence.definition?.version !== 1 || !spec || spec.chainId !== shape.chainId
    || String(spec.contract).toLowerCase() !== shape.contract.toLowerCase()
    || String(spec.selector).toLowerCase() !== shape.selector.toLowerCase()) {
    throw new Error('ClearSign review describes a different call')
  }
  return {
    spec,
    review: {
      requestId: String(review.requestId), auditId: String(review.auditId), evidenceHash,
      publishedAt: Number(review.publishedAt), auditedIdentities: deploymentIdentities(evidence.identities),
      stateReference: String(evidence.stateReference || ''), approversPinned,
      approvals: [...roles].map(([role, reviewer]) => ({ role, reviewer })),
    },
  }
}

/** Validate a hosted assessment and match its deployment. Attribution is a
 * publisher claim; this does not authenticate an auditor or prove the opinion. */
export function validateContractRating(served: any, chainId: number, contract: string, live: unknown): ContractRating | undefined {
  const rating = served?.rating
  const network = `eip155:${chainId}`
  const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
  if (served?.source !== 'hosted-assessment' || !/^0x[0-9a-f]{64}$/.test(served.ratingId) || !text(served.rater, 120)
    || !rating || rating.version !== 1 || rating.network !== network || String(rating.contract).toLowerCase() !== contract.toLowerCase()
    || !RISK_LEVELS.includes(rating.risk?.level) || !Array.isArray(rating.risk?.reasons) || rating.risk.reasons.length > 50
    || rating.risk.reasons.some((reason: unknown) => !text(reason, 2000))
    || !Array.isArray(rating.findings) || rating.findings.length > 50
    || rating.findings.some((item: any) => !item || !['info', ...RISK_LEVELS].includes(item.severity)
      || !text(item.title, 120) || !text(item.detail, 2000) || (item.reference !== undefined && !text(item.reference, 500)))
    || !Number.isSafeInteger(rating.ratedAt) || rating.ratedAt < 1 || rating.ratedAt > Date.now() + MAX_CLOCK_SKEW_MS
    || !Array.isArray(rating.deployment) || rating.deployment.length > 3
    || !rating.deployment.some((item: any) => item?.role === 'contract' && String(item.address).toLowerCase() === contract.toLowerCase())
    || rating.deployment.some((item: any) => !item || !DEPLOYMENT_ROLES.includes(item.role)
      || !/^0x[0-9a-f]{40}$/i.test(item.address) || !/^0x[0-9a-f]{64}$/i.test(item.codeHash))
    || new Set(rating.deployment.map((item: any) => item.role)).size !== rating.deployment.length) {
    throw new Error('ClearSign audit assessment is malformed')
  }
  if (deploymentMismatch(rating.deployment, live)) return undefined
  return {
    network, contract: contract.toLowerCase(), riskLevel: rating.risk.level, riskReasons: rating.risk.reasons,
    findings: rating.findings.map((item: any) => ({ severity: item.severity, title: item.title,
      detail: item.detail, ...(item.reference ? { reference: item.reference } : {}) })),
    ratedAt: rating.ratedAt, rater: served.rater, source: 'hosted-assessment',
    reportUrl: `${serviceBase()}/audits/${served.ratingId}`,
  }
}

const serviceBase = () => String(process.env.CLEARSIGN_SERVICE_URL || DEFAULT_CLEARSIGN_SERVICE_URL).trim().replace(/\/+$/, '')

/** Best-effort assessment lookup. Missing or stale assessments do not affect clearsign. */
export async function findContractRating(chainId: number, contract: string,
  measure: (chainId: number, contract: string) => Promise<unknown>): Promise<ContractRating | undefined> {
  if (!Number.isSafeInteger(chainId) || chainId < 1 || !/^0x[0-9a-f]{40}$/i.test(contract)) return undefined
  try {
    const response = await fetch(`${serviceBase()}/v1/ratings?network=eip155:${chainId}&contract=${contract.toLowerCase()}`,
      { signal: AbortSignal.timeout(3_000) })
    const served: any = await response.json()
    if (!response.ok || !served?.rating) return undefined
    // The Worker responds { rating: { rating, ratingId, rater, source } }.
    return validateContractRating(served.rating, chainId, contract, await measure(chainId, contract))
  } catch (error: any) {
    console.warn(`[clearsign] contract rating unavailable: ${error?.message || error}`)
    return undefined
  }
}

/** The user's explicit "Request clearsign review". Sends only the public call
 * shape — never the calldata arguments, amounts, or the user's address. */
export async function requestClearSignReview(chainId: number, to: string, data: string): Promise<{ queued: boolean; requestId?: string }> {
  const calldata = String(data || '').replace(/^0x/i, '')
  if (!Number.isSafeInteger(chainId) || chainId < 1 || !/^0x[0-9a-f]{40}$/i.test(String(to || ''))
    || !/^[0-9a-f]+$/i.test(calldata) || calldata.length < 8 || calldata.length % 2) {
    throw new Error('Only a contract call can be submitted for review')
  }
  const response = await fetch(`${serviceBase()}/v1/evm/schema`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chainId, contract: to, selector: `0x${calldata.slice(0, 8).toLowerCase()}`,
      calldataLength: calldata.length / 2, requestReview: true }),
    signal: AbortSignal.timeout(10_000),
  })
  const result: any = await response.json().catch(() => null)
  const request = result?.discoveryRequest
  // No discoveryRequest at all means the service predates review requests; its
  // "not in the reviewed catalog" error would read as if the request was bad.
  if (!request) throw new Error(`The ClearSign service cannot take review requests yet (HTTP ${response.status}). Nothing was sent to reviewers.`)
  if (!request.queued) throw new Error(result?.error || `ClearSign service did not queue the request (HTTP ${response.status})`)
  return { queued: true, requestId: String(request.requestId) }
}
