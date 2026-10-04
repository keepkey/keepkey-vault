import { afterEach, describe, expect, test } from 'bun:test'

import type { ClearSignAuditEvidence, ClearSignAuditJob } from '../src/shared/types'
import type { VerifiedClearSignArtifact } from '../src/bun/clearsign-artifact-import'
import { compileUnsignedEvmV2Body } from '../src/bun/clearsign-artifact-compiler'
import { CERTIFIED_SOLANA_CATALOG, serializeSolanaSchema } from '../src/bun/solana-certified-schema'
import { clearSignIdentityHash } from '../src/bun/clearsign-promotion'
import { configureClearSignArtifactSnapshots, findPromotedEvmArtifact, findPromotedSolanaArtifact, resolvePromotedEvmArtifact, resolvePromotedSolanaArtifact } from '../src/bun/clearsign-artifact-resolver'
import noAltFixture from './fixtures/solana/relay-deposit-native-no-alt.json'
import altFixture from './fixtures/solana/relay-deposit-native-alt.json'
import { signSolanaWireTransaction } from '../src/bun/solana-signing'
import { expandClearSignAuditDrafts, observeSolanaTransaction } from '../src/bun/clearsign-observation'

const candidate = {
  source: 'sourcify' as const, address: '0x1111111111111111111111111111111111111111', selectorOrDiscriminator: '0x12345678',
  name: 'deposit', signature: 'deposit(uint256)', inputs: [{ name: 'amount', type: 'uint256' }], provenance: 'fixture',
}
const evidence: ClearSignAuditEvidence = { version: 1, auditedAt: Date.now(), chain: 'Ethereum', endpoint: 'rpc', identities: [{ address: candidate.address, role: 'contract', codeHash: 'aa' }], limitations: [] }
const bundle: any = { chain: 'Ethereum', candidate, shapeKey: 'shape', identityHash: clearSignIdentityHash(evidence) }
const payload = compileUnsignedEvmV2Body(bundle, { chainId: 1, contract: candidate.address, selector: '0x12345678', calldataLength: 36 })
const artifact: VerifiedClearSignArtifact = {
  version: 1, bundleHash: '11'.repeat(32), shapeKey: 'shape', chain: 'Ethereum', identityHash: bundle.identityHash,
  expiresAt: Date.now() + 60_000, payloadHash: '22'.repeat(32), payloadHex: payload.toString('hex'), signatureHex: '33'.repeat(64),
  certificateHex: '44'.repeat(139), delegatePublicKey: '02' + '55'.repeat(32), delegateAlias: 'test', reviewerFingerprints: [],
  importedAt: Date.now(), evmCertifiedEnvelopeHex: '03' + '44'.repeat(139) + payload.toString('hex') + '33'.repeat(64) + '1b',
}
const job: ClearSignAuditJob = {
  shapeKey: 'shape', chain: 'Ethereum', shape: {}, firstSeenAt: 1, lastSeenAt: 1, requestCount: 1,
  status: 'evidence-ready', lastProtectionLevel: 'P3', maxExposureClass: 'not-evaluated', attempts: 1, evidence,
}

afterEach(() => configureClearSignArtifactSnapshots(() => []))

describe('promoted artifact resolution', () => {
  test('selects exact calldata only while identity is current', () => {
    configureClearSignArtifactSnapshots(() => [{ artifact, job }])
    const hit = findPromotedEvmArtifact(1, candidate.address, `0x12345678${'00'.repeat(32)}`)
    expect(hit?.method).toBe('deposit')
    expect(findPromotedEvmArtifact(1, candidate.address, `0x12345678${'00'.repeat(64)}`)).toBeUndefined()
    configureClearSignArtifactSnapshots(() => [{ artifact, job: { ...job, status: 'identity-changed' } }])
    expect(findPromotedEvmArtifact(1, candidate.address, `0x12345678${'00'.repeat(32)}`)).toBeUndefined()
  })

  test('does not select revoked or expired artifacts', () => {
    configureClearSignArtifactSnapshots(() => [{ artifact: { ...artifact, revokedAt: Date.now() }, job }])
    expect(findPromotedEvmArtifact(1, candidate.address, `0x12345678${'00'.repeat(32)}`)).toBeUndefined()
    expect(resolvePromotedEvmArtifact(1, candidate.address, `0x12345678${'00'.repeat(32)}`).status).toBe('revoked')
    configureClearSignArtifactSnapshots(() => [{ artifact: { ...artifact, expiresAt: Date.now() - 1 }, job }])
    expect(findPromotedEvmArtifact(1, candidate.address, `0x12345678${'00'.repeat(32)}`)).toBeUndefined()
    expect(resolvePromotedEvmArtifact(1, candidate.address, `0x12345678${'00'.repeat(32)}`).status).toBe('expired')
  })

  test('fails closed when deployed-code identity evidence is stale', () => {
    const staleEvidence = { ...evidence, auditedAt: Date.now() - 5 * 60 * 1000 - 1 }
    configureClearSignArtifactSnapshots(() => [{ artifact, job: { ...job, evidence: staleEvidence } }])
    expect(findPromotedEvmArtifact(1, candidate.address, `0x12345678${'00'.repeat(32)}`)).toBeUndefined()
    expect(resolvePromotedEvmArtifact(1, candidate.address, `0x12345678${'00'.repeat(32)}`).status).toBe('identity-stale')
  })

  test('auto-attaches an exact self-contained Solana artifact but refuses ALT transactions', async () => {
    const solEvidence: ClearSignAuditEvidence = {
      version: 1, auditedAt: Date.now(), chain: 'Solana', endpoint: 'rpc',
      identities: [{ address: CERTIFIED_SOLANA_CATALOG.relayDepositNative.programId, role: 'program', codeHash: 'bb' }], limitations: [],
    }
    const solPayload = serializeSolanaSchema(CERTIFIED_SOLANA_CATALOG.relayDepositNative)
    const solObserved = observeSolanaTransaction({ rawTxBase64: noAltFixture.rawTxBase64 })
    const solShapeKey = expandClearSignAuditDrafts(solObserved).find(draft =>
      ((draft.shape.components as any[])?.[0]?.program) === CERTIFIED_SOLANA_CATALOG.relayDepositNative.programId)!.shapeKey
    const solArtifact: VerifiedClearSignArtifact = {
      ...artifact, bundleHash: '66'.repeat(32), shapeKey: solShapeKey, chain: 'Solana', identityHash: clearSignIdentityHash(solEvidence),
      payloadHex: solPayload.toString('hex'), evmCertifiedEnvelopeHex: undefined,
      solana: { schemaPayloadHex: solPayload.toString('hex'), schemaSignatureHex: '77'.repeat(64), signerKeyId: 128, certificateHex: '88'.repeat(139) },
    }
    const solJob: ClearSignAuditJob = { ...job, shapeKey: solShapeKey, chain: 'Solana', evidence: solEvidence }
    configureClearSignArtifactSnapshots(() => [{ artifact: solArtifact, job: solJob }])
    expect(findPromotedSolanaArtifact(noAltFixture.rawTxBase64)?.bundleHash).toBe(solArtifact.bundleHash)
    const privilegeMutation = Buffer.from(noAltFixture.rawTxBase64, 'base64')
    privilegeMutation[67] = 1 // v0 message header: make the only signer readonly
    expect(findPromotedSolanaArtifact(privilegeMutation.toString('base64'))).toBeUndefined()
    expect(resolvePromotedSolanaArtifact(privilegeMutation.toString('base64')).status).toBe('shape-mismatch')
    expect(findPromotedSolanaArtifact(altFixture.rawTxBase64)).toBeUndefined()
    expect(resolvePromotedSolanaArtifact(altFixture.rawTxBase64).status).toBe('unsupported-alt')
    let deviceRequest: any
    const signed = await signSolanaWireTransaction(
      { rawTx: noAltFixture.rawTxBase64, addressNList: [1] },
      async request => { deviceRequest = request; return { signature: new Uint8Array(64).fill(9) } },
      async () => noAltFixture.expected.staticAccounts[0],
    )
    expect(deviceRequest.schema).toEqual(solArtifact.solana && {
      payload: solArtifact.solana.schemaPayloadHex, signature: solArtifact.solana.schemaSignatureHex, signerKeyId: 128,
    })
    expect(deviceRequest.certificate).toBe(solArtifact.solana?.certificateHex)
    expect(signed.clearSignPromotionBundleHash).toBe(solArtifact.bundleHash)
  })
})
