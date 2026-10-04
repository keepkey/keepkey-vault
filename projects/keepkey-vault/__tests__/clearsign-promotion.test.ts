import { describe, expect, test } from 'bun:test'
import { utils as ethersUtils } from 'ethers'

import type { ClearSignAuditEvidence, ClearSignPromotionBundle, ClearSignPromotionReview } from '../src/shared/types'
import {
  clearSignIdentityHash,
  clearSignPromotionBundleHash,
  clearSignPromotionReviewDigest,
  evaluateClearSignPromotion,
} from '../src/bun/clearsign-promotion'
import { compilePromotedClearSignArtifact, compileUnsignedEvmV2Body, compileUnsignedSolanaSchema } from '../src/bun/clearsign-artifact-compiler'
import { ClearSignPromotionBundleRequest } from '../src/bun/schemas'

const NOW = 1_800_000_000_000
const evidence: ClearSignAuditEvidence = {
  version: 1, auditedAt: NOW, chain: 'Ethereum', endpoint: 'https://rpc.example', stateReference: '0x123',
  identities: [{ address: '0x1111111111111111111111111111111111111111', role: 'contract', codeHash: `0x${'ab'.repeat(32)}` }],
  limitations: [],
}
const candidate = {
  source: 'sourcify' as const, address: '0x1111111111111111111111111111111111111111',
  selectorOrDiscriminator: '0x12345678', name: 'deposit', signature: 'deposit(uint256)',
  inputs: [{ name: 'amount', type: 'uint256' }], provenance: 'https://sourcify.dev/example',
}
const bundle: ClearSignPromotionBundle = {
  version: 1, shapeKey: 'evm:shape', chain: 'Ethereum', candidate,
  identityHash: clearSignIdentityHash(evidence), createdAt: NOW, expiresAt: NOW + 86_400_000,
  fixtures: [{ transactionFingerprint: '11'.repeat(32), payloadHash: '22'.repeat(32), decodedFieldsHash: '33'.repeat(32), effectsHash: '44'.repeat(32), provenance: 'operator-reproduction' }],
  mutations: [
    { id: 'a', kind: 'truncation', fixtureHash: '55'.repeat(32), expected: 'reject', observed: 'reject' },
    { id: 'b', kind: 'selector-or-discriminator', fixtureHash: '66'.repeat(32), expected: 'reject', observed: 'reject' },
    { id: 'c', kind: 'field-boundary', fixtureHash: '77'.repeat(32), expected: 'different-display', observed: 'different-display' },
    { id: 'd', kind: 'chain-or-contract', fixtureHash: '88'.repeat(32), expected: 'reject', observed: 'reject' },
  ],
  deviceOracle: { firmwareVersion: '7.15.0', artifactHash: '99'.repeat(32), transcriptHash: 'aa'.repeat(32), passed: true },
}

function review(privateKey: string, role: ClearSignPromotionReview['role'], decision: ClearSignPromotionReview['decision'] = 'approve'): ClearSignPromotionReview {
  const key = new ethersUtils.SigningKey(privateKey)
  const bundleHash = clearSignPromotionBundleHash(bundle)
  const statement = {
    bundleHash, reviewerPublicKey: ethersUtils.computePublicKey(key.publicKey, true).slice(2), role, decision, reviewedAt: NOW,
  }
  return { ...statement, signature: ethersUtils.joinSignature(key.signDigest(`0x${clearSignPromotionReviewDigest(statement)}`)) }
}

describe('ClearSign promotion gate', () => {
  const semantics = review(`0x${'01'.padStart(64, '0')}`, 'semantics-review')
  const security = review(`0x${'02'.padStart(64, '0')}`, 'security-review')

  test('requires complete mutations, device oracle, current identity, and two signed reviews', () => {
    const verdict = evaluateClearSignPromotion({ bundle, reviews: [semantics, security], currentEvidence: evidence, now: NOW + 1 })
    expect(verdict.publishable).toBe(true)
    expect(verdict.failures).toEqual([])
    expect(verdict.reviewerFingerprints).toHaveLength(2)
  })

  test('compiles an approved flat ABI to an unsigned firmware-v2 signing request', () => {
    const observedShape = {
      chainId: 1, contract: candidate.address, selector: candidate.selectorOrDiscriminator, calldataLength: 36,
    }
    const artifact = compilePromotedClearSignArtifact({
      bundle, reviews: [semantics, security], currentEvidence: evidence, observedShape, now: NOW + 1,
    })
    const body = compileUnsignedEvmV2Body(bundle, observedShape)
    expect(artifact.format).toBe('evm-v2-certified-inner')
    expect(artifact.payloadHex).toBe(body.toString('hex'))
    expect(body[0]).toBe(2)
    expect(body.subarray(1, 5).readUInt32BE()).toBe(1)
    expect(body.subarray(-6).toString('hex')).toBe('010000000080')
    expect(artifact.payloadHash).toMatch(/^[0-9a-f]{64}$/)
    expect(artifact).not.toHaveProperty('signature')
  })

  test('compiler rejects dynamic ABI and incomplete calldata coverage', () => {
    const dynamic = { ...bundle, candidate: { ...candidate, signature: 'deposit(bytes)', inputs: [{ name: 'payload', type: 'bytes' }] } }
    const shape = { chainId: 1, contract: candidate.address, selector: candidate.selectorOrDiscriminator, calldataLength: 36 }
    expect(() => compileUnsignedEvmV2Body(dynamic, shape)).toThrow('not supported')
    expect(() => compileUnsignedEvmV2Body(bundle, { ...shape, calldataLength: 68 })).toThrow('complete observed calldata')
  })

  test('compiler keeps exact EIP-712 discovery audit-only until firmware supports typed data', () => {
    const typedShape = {
      chainId: 1,
      contract: candidate.address,
      primaryType: 'PermitSingle',
      encodeTypeHash: `0x${'12'.repeat(32)}`,
    }
    expect(() => compileUnsignedEvmV2Body(bundle, typedShape)).toThrow('typed-data-capable firmware format')
  })

  test('active ERC-7730 candidates preserve only faithfully representable display semantics', () => {
    const erc7730Bundle: ClearSignPromotionBundle = {
      ...bundle, candidate: {
        ...candidate, source: 'erc7730-registry', provenance: 'registry fixture#sha256',
        erc7730Display: {
          intent: 'Deposit ETH', hasIncludes: false, requiredOrExcluded: false, fieldsTruncated: false,
          fields: [{ path: 'amount', label: 'Native amount', format: 'amount', hasParams: false, encrypted: false }],
        },
      },
    }
    const shape = { chainId: 1, contract: candidate.address, selector: candidate.selectorOrDiscriminator, calldataLength: 36 }
    const compiled = compileUnsignedEvmV2Body(erc7730Bundle, shape)
    expect(compiled).not.toEqual(compileUnsignedEvmV2Body(bundle, shape))
    expect(compiled.includes(Buffer.from('Deposit ETH'))).toBe(true)
    expect(compiled.includes(Buffer.from('Native amount'))).toBe(true)
    expect(ClearSignPromotionBundleRequest.parse(erc7730Bundle).candidate.erc7730Display?.intent).toBe('Deposit ETH')
    expect(() => compileUnsignedEvmV2Body(erc7730Bundle, { ...shape, calldataLength: 68 })).toThrow('complete observed calldata')
    const tokenAmount = {
      ...erc7730Bundle,
      candidate: { ...erc7730Bundle.candidate, erc7730Display: {
        ...erc7730Bundle.candidate.erc7730Display!,
        fields: [{ path: 'amount', label: 'Token amount', format: 'tokenAmount', hasParams: true, encrypted: false }],
      } },
    }
    expect(() => compileUnsignedEvmV2Body(tokenAmount, shape)).toThrow('not representable')
  })

  test('Solana compiler binds IDL account signer and writable privileges', () => {
    const solBundle: ClearSignPromotionBundle = {
      ...bundle, chain: 'Solana', shapeKey: 'solana:shape',
      candidate: {
        source: 'anchor-idl', address: '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2',
        selectorOrDiscriminator: '0102030405060708', name: 'deposit',
        inputs: [{ name: 'amount', type: 'u64' }],
        accounts: [{ name: 'player', signer: true, writable: true }], provenance: 'fixture',
      },
    }
    const shape = { components: [{
      program: solBundle.candidate.address, prefix8: '0102030405060708', dataLength: 16,
      accountPrivileges: [{ index: 0, signer: true, writable: true }],
    }] }
    expect(() => compileUnsignedSolanaSchema(solBundle, shape)).not.toThrow()
    const mutated = { components: [{ ...shape.components[0], accountPrivileges: [{ index: 0, signer: true, writable: false }] }] }
    expect(() => compileUnsignedSolanaSchema(solBundle, mutated)).toThrow('writable privilege differs')
  })

  test('one key cannot satisfy two review roles', () => {
    const sameKeySecurity = review(`0x${'01'.padStart(64, '0')}`, 'security-review')
    const verdict = evaluateClearSignPromotion({ bundle, reviews: [semantics, sameKeySecurity], currentEvidence: evidence, now: NOW + 1 })
    expect(verdict.publishable).toBe(false)
    expect(verdict.failures).toContain('TWO_DISTINCT_REVIEWERS_REQUIRED')
  })

  test('fails closed on code change, mutation pass, revocation, and forged review', () => {
    const changed = { ...evidence, identities: [{ ...evidence.identities[0], codeHash: `0x${'cd'.repeat(32)}` }] }
    const unsafe = { ...bundle, mutations: bundle.mutations.map((entry, index) => index === 0 ? { ...entry, observed: 'unexpected-pass' as const } : entry) }
    const forged = { ...security, signature: semantics.signature }
    const verdict = evaluateClearSignPromotion({
      bundle: unsafe, reviews: [semantics, forged], currentEvidence: changed,
      revokedBundleHashes: [clearSignPromotionBundleHash(unsafe)], now: NOW + 1,
    })
    expect(verdict.publishable).toBe(false)
    expect(verdict.failures).toContain('CODE_IDENTITY_CHANGED')
    expect(verdict.failures).toContain('MUTATION_FAILED:truncation')
    expect(verdict.failures).toContain('BUNDLE_REVOKED')
    expect(verdict.failures).toContain('TWO_DISTINCT_REVIEWERS_REQUIRED')
  })

  test('a valid signature cannot be replayed with a different role or decision', () => {
    const changedRole = { ...semantics, role: 'security-review' as const }
    const changedDecision = { ...semantics, decision: 'reject' as const }
    expect(evaluateClearSignPromotion({ bundle, reviews: [changedRole, security], currentEvidence: evidence, now: NOW + 1 }).publishable).toBe(false)
    expect(evaluateClearSignPromotion({ bundle, reviews: [changedDecision, security], currentEvidence: evidence, now: NOW + 1 }).failures).not.toContain('REVIEW_REJECTED')
  })
})
