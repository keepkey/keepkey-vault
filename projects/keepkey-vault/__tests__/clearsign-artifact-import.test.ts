import { describe, expect, test } from 'bun:test'
import { utils as ethersUtils } from 'ethers'

import type { ClearSignAuditEvidence, ClearSignPromotionBundle, ClearSignPromotionReview } from '../src/shared/types'
import { clearSignIdentityHash, clearSignPromotionBundleHash, clearSignPromotionReviewDigest } from '../src/bun/clearsign-promotion'
import { importPromotedClearSignArtifact } from '../src/bun/clearsign-artifact-import'
import arbitrumCertificate from '../../../docs/clearsign-case-studies/uniswap-usdt/arbitrum-certificate.json'

// Public production Relay envelope returned by /v1/evm/schema. It contains a
// root certificate and signatures only; no private key or transaction data.
const ENVELOPE = '030101000000016b359b004b6565704b657920416c706861203731360000000000000000000000000000000342f5f9704494b3f9bd72295eecaf29d783d23ea02b2dc9f48abcd2e46d4850cffc4364672f0172aa70ed21eacc2ea8bd0d333119ddf048b096686e1a8e56bda438f9e70b9cfc229a1e93e2d91846c31c4083d8b176e225d76341069dd22826cf02000000014cd00e387622c35bddb9b4c962c136462338bc3149290c1c000d6272696467654465706f73697402096465706f7369746f7201076f72646572496403010000000080500eca0f7b0521c5d0ee5f6ff406eca34e97bf9fa72c450a65a2248004c6c5107f9cc0a3c7816cedd06c3206a0c6e6242b228190a5b1da773561065c6f0e86cc1b'
const NOW = 1_789_000_000_000
const evidence: ClearSignAuditEvidence = {
  version: 1, auditedAt: NOW, chain: 'Ethereum', endpoint: 'public-chain', stateReference: '0x1',
  identities: [{ address: '0x4cd00e387622c35bddb9b4c962c136462338bc31', role: 'contract', codeHash: `0x${'ab'.repeat(32)}` }], limitations: [],
}
const bundle: ClearSignPromotionBundle = {
  version: 1, shapeKey: 'evm:relay', chain: 'Ethereum', identityHash: clearSignIdentityHash(evidence),
  createdAt: NOW - 1_000, expiresAt: 1_790_000_000_000,
  candidate: {
    source: 'sourcify', address: '0x4cd00e387622c35bddb9b4c962c136462338bc31', selectorOrDiscriminator: '0x49290c1c',
    name: 'bridgeDeposit', signature: 'bridgeDeposit(address,bytes32)',
    inputs: [{ name: 'depositor', type: 'address' }, { name: 'orderId', type: 'bytes32' }], provenance: 'public fixture',
  },
  fixtures: [{ transactionFingerprint: '11'.repeat(32), payloadHash: '22'.repeat(32), decodedFieldsHash: '33'.repeat(32), effectsHash: '44'.repeat(32), provenance: 'public-chain' }],
  mutations: [
    { id: 'a', kind: 'truncation', fixtureHash: '55'.repeat(32), expected: 'reject', observed: 'reject' },
    { id: 'b', kind: 'selector-or-discriminator', fixtureHash: '66'.repeat(32), expected: 'reject', observed: 'reject' },
    { id: 'c', kind: 'field-boundary', fixtureHash: '77'.repeat(32), expected: 'different-display', observed: 'different-display' },
    { id: 'd', kind: 'chain-or-contract', fixtureHash: '88'.repeat(32), expected: 'reject', observed: 'reject' },
  ],
  deviceOracle: { firmwareVersion: '7.16.0', artifactHash: '99'.repeat(32), transcriptHash: 'aa'.repeat(32), passed: true },
}

function review(keyHex: string, role: ClearSignPromotionReview['role']): ClearSignPromotionReview {
  const key = new ethersUtils.SigningKey(keyHex)
  const statement = { bundleHash: clearSignPromotionBundleHash(bundle), reviewerPublicKey: ethersUtils.computePublicKey(key.publicKey, true).slice(2), role, decision: 'approve' as const, reviewedAt: NOW }
  return { ...statement, signature: ethersUtils.joinSignature(key.signDigest(`0x${clearSignPromotionReviewDigest(statement)}`)) }
}

describe('offline ClearSign artifact ceremony import', () => {
  const reviews = [review(`0x${'01'.padStart(64, '0')}`, 'semantics-review'), review(`0x${'02'.padStart(64, '0')}`, 'security-review')]
  const bytes = Buffer.from(ENVELOPE, 'hex')
  const certificate = bytes.subarray(1, 140)
  const inner = bytes.subarray(140)
  const payload = inner.subarray(0, -65)
  const signature = inner.subarray(-65, -1)
  const recovery = inner[inner.length - 1]

  test('verifies root certificate, delegate signature, promotion, and exact compiler payload', () => {
    const artifact = importPromotedClearSignArtifact({
      bundle, reviews, currentEvidence: evidence,
      observedShape: { chainId: 1, contract: bundle.candidate.address, selector: '0x49290c1c', calldataLength: 68 },
      ceremony: { bundleHash: clearSignPromotionBundleHash(bundle), payloadHex: payload.toString('hex'), signatureHex: signature.toString('hex'), recovery, certificateHex: certificate.toString('hex') },
      now: NOW,
    })
    expect(artifact.evmCertifiedEnvelopeHex).toBe(ENVELOPE)
    expect(artifact.delegateAlias).toBe('KeepKey Alpha 716')
    expect(artifact.reviewerFingerprints).toHaveLength(2)
  })

  test('rejects payload substitution and forged delegate signatures', () => {
    const base = { bundleHash: clearSignPromotionBundleHash(bundle), payloadHex: payload.toString('hex'), signatureHex: signature.toString('hex'), recovery, certificateHex: certificate.toString('hex') }
    const common = { bundle, reviews, currentEvidence: evidence, observedShape: { chainId: 1, contract: bundle.candidate.address, selector: '0x49290c1c', calldataLength: 68 }, now: NOW }
    expect(() => importPromotedClearSignArtifact({ ...common, ceremony: { ...base, payloadHex: `${base.payloadHex.slice(0, -2)}00` } })).toThrow('differs')
    expect(() => importPromotedClearSignArtifact({ ...common, ceremony: { ...base, signatureHex: '00'.repeat(64) } })).toThrow('certified delegate')
  })

  test('requires an exact-chain root certificate for promoted Arbitrum artifacts', () => {
    const arbitrumPayload = Buffer.from(payload)
    arbitrumPayload.writeUInt32BE(42161, 1)
    const common = { bundle, reviews, currentEvidence: evidence,
      observedShape: { chainId: 42161, contract: bundle.candidate.address, selector: '0x49290c1c', calldataLength: 68 }, now: NOW }
    const ceremony = { bundleHash: clearSignPromotionBundleHash(bundle), payloadHex: arbitrumPayload.toString('hex'),
      signatureHex: signature.toString('hex'), recovery, certificateHex: certificate.toString('hex') }
    expect(() => importPromotedClearSignArtifact({ ...common, ceremony })).toThrow('certificate scope')
    // The real Arbitrum certificate passes scope verification, but the old
    // mainnet artifact signature must still fail for the modified payload.
    expect(() => importPromotedClearSignArtifact({ ...common,
      ceremony: { ...ceremony, certificateHex: arbitrumCertificate.certificateHex } })).toThrow('certified delegate')
  })
})
