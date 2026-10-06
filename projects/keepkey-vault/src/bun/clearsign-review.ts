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
 * - a contract rating: one auditor's EIP-712-signed opinion of the project.
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
/** Raters this Vault trusts. Empty: ratings verify but show as unpinned. */
export const PINNED_RATERS: string[] = []

const DOMAIN = { name: 'KeepKey ClearSign', version: '1' }
const DEFINITION_APPROVAL_TYPES = {
  DefinitionApproval: [
    { name: 'auditId', type: 'bytes32' }, { name: 'evidenceHash', type: 'bytes32' },
    { name: 'role', type: 'string' }, { name: 'decision', type: 'string' }, { name: 'reviewedAt', type: 'uint64' },
  ],
}
const CONTRACT_RATING_TYPES = {
  ContractRating: [
    { name: 'network', type: 'string' }, { name: 'contract', type: 'address' }, { name: 'deploymentHash', type: 'bytes32' },
    { name: 'riskLevel', type: 'string' }, { name: 'ratingHash', type: 'bytes32' }, { name: 'ratedAt', type: 'uint64' },
  ],
}
const RISK_LEVELS = ['low', 'medium', 'high', 'critical']

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

/**
 * Verify a contract rating served by /v1/ratings: the EIP-712 ContractRating
 * signature commits to this exact rating content, deployment and risk level.
 * Returns it only if it rates the deployment measured now.
 */
export function verifyContractRating(served: any, chainId: number, contract: string, live: unknown,
  pinned = PINNED_RATERS): ContractRating | undefined {
  const rating = served?.rating
  const network = `eip155:${chainId}`
  if (!rating || rating.version !== 1 || rating.network !== network || String(rating.contract).toLowerCase() !== contract.toLowerCase()
    || !RISK_LEVELS.includes(rating.risk?.level) || !Array.isArray(rating.findings) || !Number.isSafeInteger(rating.ratedAt)) {
    throw new Error('ClearSign rating is malformed')
  }
  const message = { network, contract: String(rating.contract).toLowerCase(), deploymentHash: `0x${sha(rating.deployment)}`,
    riskLevel: rating.risk.level, ratingHash: `0x${sha(rating)}`, ratedAt: rating.ratedAt }
  const rater = signer(CONTRACT_RATING_TYPES, message, served.signature)
  if (rater !== String(served.rater).toLowerCase()) throw new Error('ClearSign rating signature is invalid')
  const raterPinned = pinned.map((item) => item.toLowerCase()).includes(rater)
  if (pinned.length && !raterPinned) throw new Error('ClearSign rating is signed by a rater this Vault does not trust')
  // An opinion about a different deployment says nothing about this one.
  if (deploymentMismatch(rating.deployment, live)) return undefined
  return {
    network, contract: message.contract, riskLevel: rating.risk.level, riskReasons: (rating.risk.reasons || []).map(String),
    findings: rating.findings.map((item: any) => ({ severity: String(item.severity), title: String(item.title),
      detail: String(item.detail), ...(item.reference ? { reference: String(item.reference) } : {}) })),
    ratedAt: rating.ratedAt, rater, raterPinned,
  }
}

const serviceBase = () => String(process.env.CLEARSIGN_SERVICE_URL || DEFAULT_CLEARSIGN_SERVICE_URL).trim().replace(/\/+$/, '')

/** Best-effort: the verified rating of this contract's live deployment, or
 * undefined for no rating, a stale deployment, any failure, or a bad signature. */
export async function findContractRating(chainId: number, contract: string,
  measure: (chainId: number, contract: string) => Promise<unknown>): Promise<ContractRating | undefined> {
  if (!Number.isSafeInteger(chainId) || chainId < 1 || !/^0x[0-9a-f]{40}$/i.test(contract)) return undefined
  try {
    const response = await fetch(`${serviceBase()}/v1/ratings?network=eip155:${chainId}&contract=${contract.toLowerCase()}`,
      { signal: AbortSignal.timeout(3_000) })
    const served: any = await response.json()
    if (!response.ok || !served?.rating) return undefined
    return verifyContractRating(served, chainId, contract, await measure(chainId, contract))
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
  if (!request?.queued) throw new Error(result?.error || `ClearSign service did not queue the request (HTTP ${response.status})`)
  return { queued: true, requestId: String(request.requestId) }
}
