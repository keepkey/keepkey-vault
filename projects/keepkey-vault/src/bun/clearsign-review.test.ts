import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { Wallet } from 'ethers'

import { buildEvmSchemaBody, CERTIFIED_METADATA_KEY_ID } from './evm-certified-schema'
import { deploymentMismatch, findContractRating, verifyContractRating, verifyPublishedReview } from './clearsign-review'
import { findCertifiedEvmSchema } from './evm-schema-registry'

// The MDM case study: Mordiem CapitalManager.deposit(address asset, uint256 amount) on Base.
const MANAGER = '0x6b6c05ee7f49d00e63e74a9426d74ef9614f6a0f'
const DEPOSIT = '0x47e7ef24'
const SHAPE = { chainId: 8453, contract: MANAGER, selector: DEPOSIT, calldataLength: 68 }
const CALLDATA = `${DEPOSIT}${'833589fcd6edb6e08f4c7c32d4f71b54bda02913'.padStart(64, '0')}${(100_000_000n).toString(16).padStart(64, '0')}`
const SCHEMA = { chainId: 8453, contract: MANAGER, selector: DEPOSIT, method: 'Mordiem capital deposit',
  args: [{ name: 'Asset', format: 1 }, { name: 'Amount', format: 2 }], expectedCalldataLength: 68 }
// MDM's CapitalManager is a UUPS proxy: the audit pins the proxy AND its implementation.
const IMPLEMENTATION = '0xed36c1df5e9865165916190dcf4c1bf93ad2a9e2'
const AUDITED = [
  { address: MANAGER, role: 'contract', codeHash: `0x${'cd'.repeat(32)}` },
  { address: IMPLEMENTATION, role: 'implementation', codeHash: `0x${'ee'.repeat(32)}` },
]
const unchanged = async () => AUDITED
const semantics = new Wallet(`0x${'0a'.padStart(64, '0')}`)
const security = new Wallet(`0x${'0b'.padStart(64, '0')}`)
const rater = new Wallet(`0x${'0c'.padStart(64, '0')}`)
const addr = (w: Wallet) => w.address.toLowerCase()

// Must match keepkey-clearsign-server worker/src/attestation.ts.
const DOMAIN = { name: 'KeepKey ClearSign', version: '1' }
const APPROVAL = { DefinitionApproval: [{ name: 'auditId', type: 'bytes32' }, { name: 'evidenceHash', type: 'bytes32' },
  { name: 'role', type: 'string' }, { name: 'decision', type: 'string' }, { name: 'reviewedAt', type: 'uint64' }] }
const RATING = { ContractRating: [{ name: 'network', type: 'string' }, { name: 'contract', type: 'address' },
  { name: 'deploymentHash', type: 'bytes32' }, { name: 'riskLevel', type: 'string' }, { name: 'ratingHash', type: 'bytes32' },
  { name: 'ratedAt', type: 'uint64' }] }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
const sha = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

/** A definition review exactly as the ClearSign Worker serves it (findPublishedEvm). */
async function publishedReview(keys: [Wallet, Wallet] = [semantics, security]) {
  const evidence = {
    version: 1, chain: 'Ethereum', auditedAt: 1, endpoint: 'https://mainnet.base.org', stateReference: 'block:0x1',
    identities: structuredClone(AUDITED), candidates: [], limitations: [], definition: { version: 1, schema: structuredClone(SCHEMA) },
  }
  const evidenceHash = sha(evidence)
  const auditId = createHash('sha256').update(`req:${evidenceHash}`).digest('hex')
  const approvals = await Promise.all(([[keys[0], 'semantics-review'], [keys[1], 'security-review']] as const).map(async ([key, role]) => {
    const statement = { version: 1, auditId, evidenceHash, decision: 'approve', role, reviewer: addr(key), reviewedAt: 1 }
    const signature = await key._signTypedData(DOMAIN, APPROVAL, { auditId: `0x${auditId}`, evidenceHash: `0x${evidenceHash}`,
      role, decision: 'approve', reviewedAt: 1 })
    return { role, reviewer: addr(key), statement, signature }
  }))
  return { requestId: 'req', auditId, evidenceHash, publishedAt: 2, evidence, approvals }
}

/** A rating exactly as the Worker serves /v1/ratings. */
async function servedRating(key = rater, deployment = AUDITED) {
  const rating = { version: 1, network: 'eip155:8453', contract: MANAGER, deployment, ratedAt: 5,
    factors: { sourceVerified: true, upgradeable: true, adminDelaySeconds: 864000, controller: 'single-key', privilegedFundAccess: true, uncappedMint: true },
    findings: [{ severity: 'high', title: 'Single-key upgrade control', detail: '1-of-1 EOA Safe behind a 10-day timelock.' }],
    risk: { rubric: 'keepkey-contract-risk-v1', level: 'high', reasons: ['a single key controls upgrades, deposits, minting (delay 10d)'] } }
  const signature = await key._signTypedData(DOMAIN, RATING, { network: rating.network, contract: MANAGER,
    deploymentHash: `0x${sha(deployment)}`, riskLevel: 'high', ratingHash: `0x${sha(rating)}`, ratedAt: 5 })
  return { rating, rater: addr(key), signature }
}

describe('verifyPublishedReview (clearsign definition)', () => {
  it('accepts two distinct EIP-712 approvals of the MDM definition and carries no opinion', async () => {
    const { spec, review } = verifyPublishedReview(await publishedReview(), SHAPE)
    expect(spec.method).toBe('Mordiem capital deposit')
    expect(review.approvals.map((a) => a.reviewer).sort()).toEqual([addr(semantics), addr(security)].sort())
    expect(review.approversPinned).toBe(false)
    expect((review as any).riskLevel).toBeUndefined()
  })

  it('refuses evidence edited after the approvers signed it', async () => {
    const review = await publishedReview()
    review.evidence.definition.schema.method = 'Something else'
    expect(() => verifyPublishedReview(review, SHAPE)).toThrow('does not match its hash')
  })

  it('refuses one signer holding both roles', async () => {
    const review = await publishedReview([semantics, semantics])
    expect(() => verifyPublishedReview(review, SHAPE)).toThrow('two distinct approvals')
  })

  it('refuses approvers this Vault does not pin, once any is pinned', async () => {
    const review = await publishedReview()
    const pinned = { [addr(semantics)]: ['semantics-review' as const] }
    expect(() => verifyPublishedReview(review, SHAPE, pinned)).toThrow('does not trust')
    expect(verifyPublishedReview(review, SHAPE, { ...pinned, [addr(security)]: ['security-review' as const] }).review.approversPinned).toBe(true)
  })

  it('refuses a review of a different call', async () => {
    const review = await publishedReview()
    expect(() => verifyPublishedReview(review, { ...SHAPE, selector: '0xdeadbeef' })).toThrow('different call')
  })
})

describe('verifyContractRating (app-only opinion)', () => {
  it('accepts the signed MDM rating for the live deployment', async () => {
    const rating = verifyContractRating(await servedRating(), 8453, MANAGER, AUDITED)
    expect(rating).toMatchObject({ riskLevel: 'high', rater: addr(rater), raterPinned: false })
    expect(rating?.findings).toHaveLength(1)
  })

  it('ignores a rating of a different deployment', async () => {
    const upgraded = [AUDITED[0], { ...AUDITED[1], codeHash: `0x${'ab'.repeat(32)}` }]
    expect(verifyContractRating(await servedRating(), 8453, MANAGER, upgraded)).toBeUndefined()
  })

  it('refuses a rating whose content or level was changed after signing', async () => {
    const served = await servedRating()
    served.rating.risk.level = 'low'
    expect(() => verifyContractRating(served, 8453, MANAGER, AUDITED)).toThrow('signature is invalid')
  })

  it('refuses an unpinned rater once raters are pinned', async () => {
    const served = await servedRating(semantics)
    expect(() => verifyContractRating(served, 8453, MANAGER, AUDITED, [addr(rater)])).toThrow('does not trust')
  })

  it('findContractRating is best-effort: no rating, bad data, or no network are all undefined', async () => {
    const original = globalThis.fetch
    try {
      globalThis.fetch = (async () => Response.json({ rating: null })) as unknown as typeof fetch
      expect(await findContractRating(8453, MANAGER, unchanged)).toBeUndefined()
      const tampered = await servedRating(); tampered.rating.findings = []
      globalThis.fetch = (async () => Response.json(tampered)) as unknown as typeof fetch
      expect(await findContractRating(8453, MANAGER, unchanged)).toBeUndefined()
      globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
      expect(await findContractRating(8453, MANAGER, unchanged)).toBeUndefined()
      const good = await servedRating()
      globalThis.fetch = (async () => Response.json(good)) as unknown as typeof fetch
      expect((await findContractRating(8453, MANAGER, unchanged))?.riskLevel).toBe('high')
    } finally { globalThis.fetch = original }
  })
})

describe('findCertifiedEvmSchema definition lookup', () => {
  const envelope = (body: Buffer) => `0x03${'00'.repeat(2)}${(8453).toString(16).padStart(8, '0')}${'00'.repeat(133)}${body.toString('hex')}${'11'.repeat(65)}`
  const serve = (json: any, status = 200) => (async () => new Response(JSON.stringify(json), { status })) as unknown as typeof fetch
  const verified = (review: any, body = buildEvmSchemaBody(SCHEMA as any)) => ({ success: true, classification: 'VERIFIED',
    signedPayload: envelope(body), keyId: CERTIFIED_METADATA_KEY_ID, method: SCHEMA.method, chainId: 8453,
    contract: MANAGER, selector: DEPOSIT, expectedCalldataLength: 68, review })

  async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>) {
    const original = globalThis.fetch
    globalThis.fetch = impl
    try { return await run() } finally { globalThis.fetch = original }
  }

  it('returns the reviewed envelope with its verified definition review', async () => {
    const result = await withFetch(serve(verified(await publishedReview())), () => findCertifiedEvmSchema(8453, MANAGER, CALLDATA, unchanged))
    expect(result?.method).toBe('Mordiem capital deposit')
    expect(result?.definitionReview?.approvals).toHaveLength(2)
  })

  it('falls back to blind when the envelope body differs from the reviewed schema', async () => {
    const other = buildEvmSchemaBody({ ...SCHEMA, method: 'Something else' } as any)
    const review = await publishedReview()
    expect(await withFetch(serve(verified(review, other)), () => findCertifiedEvmSchema(8453, MANAGER, CALLDATA, unchanged))).toBeUndefined()
  })

  it('stops clearsigning after an upgrade or when the deployment cannot be measured', async () => {
    const review = await publishedReview()
    const upgraded = async () => [AUDITED[0], { address: '0x' + '99'.repeat(20), role: 'implementation', codeHash: `0x${'aa'.repeat(32)}` }]
    const unmeasurable = async () => { throw new Error('rpc down') }
    for (const measure of [upgraded, unmeasurable]) {
      expect(await withFetch(serve(verified(review)), () => findCertifiedEvmSchema(8453, MANAGER, CALLDATA, measure))).toBeUndefined()
    }
  })

  it('falls back to blind on a tampered review, a miss, or an unreachable service', async () => {
    const tampered = await publishedReview()
    tampered.evidence.definition.schema.args = []
    expect(await withFetch(serve(verified(tampered)), () => findCertifiedEvmSchema(8453, MANAGER, CALLDATA, unchanged))).toBeUndefined()
    expect(await withFetch(serve({ classification: 'OPAQUE' }, 422), () => findCertifiedEvmSchema(8453, MANAGER, CALLDATA, unchanged))).toBeUndefined()
    expect(await withFetch((async () => { throw new Error('offline') }) as unknown as typeof fetch,
      () => findCertifiedEvmSchema(8453, MANAGER, CALLDATA, unchanged))).toBeUndefined()
  })
})

describe('deploymentMismatch', () => {
  it('is silent for the audited deployment and names what changed otherwise', () => {
    expect(deploymentMismatch(AUDITED, AUDITED)).toBeUndefined()
    expect(deploymentMismatch(AUDITED, [AUDITED[0], { ...AUDITED[1], codeHash: `0x${'ab'.repeat(32)}` }]))
      .toBe('the deployed implementation changed since the audit')
    expect(deploymentMismatch(AUDITED, [{ ...AUDITED[0], codeHash: `0x${'01'.repeat(32)}` }]))
      .toBe('the deployed contract, implementation changed since the audit')
    expect(deploymentMismatch(AUDITED, [{ ...AUDITED[0], codeHash: undefined as any }])).toBe('the contract has no deployed code to compare')
  })
})
