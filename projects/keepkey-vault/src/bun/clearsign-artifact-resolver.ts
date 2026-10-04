import type { ClearSignAuditJob } from '../shared/types'
import bs58 from 'bs58'
import type { VerifiedClearSignArtifact } from './clearsign-artifact-import'
import { clearSignIdentityHash } from './clearsign-promotion'
import { inspectSolanaSchema } from './clearsign-studio'
import { parseSolanaMessage, parseSolanaTx, solanaMessageSlice } from './solana-tx'
import { expandClearSignAuditDrafts, observeSolanaTransaction } from './clearsign-observation'

type ActiveArtifact = VerifiedClearSignArtifact & { revokedAt?: number }
type Snapshot = { artifact: ActiveArtifact; job?: ClearSignAuditJob }
export type ClearSignArtifactRefusal = 'invalid-request' | 'no-artifact' | 'shape-mismatch' | 'revoked' | 'expired'
  | 'identity-unavailable' | 'identity-stale' | 'identity-changed' | 'identity-mismatch' | 'unsupported-alt'
export type ClearSignArtifactResolution<T> = { status: 'selected'; artifact: T } | { status: ClearSignArtifactRefusal }
let snapshotProvider: () => Snapshot[] = () => []
export const CLEARSIGN_IDENTITY_MAX_AGE_MS = 5 * 60 * 1000

function identityRefusal(job: ClearSignAuditJob | undefined, identityHash: string): ClearSignArtifactRefusal | undefined {
  if (!job?.evidence) return 'identity-unavailable'
  if (job.status === 'identity-changed') return 'identity-changed'
  if (clearSignIdentityHash(job.evidence) !== identityHash) return 'identity-mismatch'
  if (job.evidence.auditedAt < Date.now() - CLEARSIGN_IDENTITY_MAX_AGE_MS) return 'identity-stale'
  if (job.status !== 'evidence-ready' && job.status !== 'covered') return 'identity-unavailable'
  return undefined
}

/** The DB layer registers this once. Keeping storage behind this seam prevents
 * pure schema matching from booting ElectroBun or owning database lifecycle. */
export function configureClearSignArtifactSnapshots(provider: () => Snapshot[]): void {
  snapshotProvider = provider
}

export function findPromotedEvmArtifact(chainId: number | undefined, to: string | undefined, data: string | undefined): {
  bundleHash: string; method: string; signedPayload: string; expectedCalldataLength: number; expiresAt: number
} | undefined {
  const resolution = resolvePromotedEvmArtifact(chainId, to, data)
  return resolution.status === 'selected' ? resolution.artifact : undefined
}

export function resolvePromotedEvmArtifact(chainId: number | undefined, to: string | undefined, data: string | undefined): ClearSignArtifactResolution<{
  bundleHash: string; method: string; signedPayload: string; expectedCalldataLength: number; expiresAt: number
}> {
  if (!chainId || !to || !data) return { status: 'invalid-request' }
  const calldata = data.replace(/^0x/i, '')
  if (!/^[0-9a-f]+$/i.test(calldata) || calldata.length < 8 || calldata.length % 2) return { status: 'invalid-request' }
  for (const { artifact, job } of snapshotProvider()) {
    if (artifact.chain !== 'Ethereum' || !artifact.evmCertifiedEnvelopeHex) continue
    try {
      const payload = Buffer.from(artifact.payloadHex, 'hex')
      if (payload[0] !== 2 || payload.length < 39) continue
      const schemaChain = payload.readUInt32BE(1)
      const contract = `0x${payload.subarray(5, 25).toString('hex')}`
      const selector = `0x${payload.subarray(25, 29).toString('hex')}`
      const methodLength = payload.readUInt16BE(29)
      const numArgsOffset = 31 + methodLength
      if (numArgsOffset >= payload.length) continue
      const expectedCalldataLength = 4 + payload[numArgsOffset] * 32
      if (schemaChain !== chainId || contract.toLowerCase() !== to.toLowerCase()
        || selector !== `0x${calldata.slice(0, 8).toLowerCase()}`) continue
      if (calldata.length / 2 !== expectedCalldataLength) return { status: 'shape-mismatch' }
      if (artifact.revokedAt) return { status: 'revoked' }
      if (artifact.expiresAt <= Date.now()) return { status: 'expired' }
      const refusal = identityRefusal(job, artifact.identityHash)
      if (refusal) return { status: refusal }
      return { status: 'selected', artifact: {
        bundleHash: artifact.bundleHash,
        method: payload.subarray(31, numArgsOffset).toString('ascii'),
        signedPayload: `0x${artifact.evmCertifiedEnvelopeHex}`,
        expectedCalldataLength,
        expiresAt: artifact.expiresAt,
      } }
    } catch { /* malformed persisted data is never selected */ }
  }
  return { status: 'no-artifact' }
}

export function findPromotedSolanaArtifact(rawTxBase64: string | undefined): {
  bundleHash: string
  label: string
  expiresAt: number
  schema: { payload: string; signature: string; signerKeyId: 128 }
  certificate: string
} | undefined {
  const resolution = resolvePromotedSolanaArtifact(rawTxBase64)
  return resolution.status === 'selected' ? resolution.artifact : undefined
}

export function resolvePromotedSolanaArtifact(rawTxBase64: string | undefined): ClearSignArtifactResolution<{
  bundleHash: string
  label: string
  expiresAt: number
  schema: { payload: string; signature: string; signerKeyId: 128 }
  certificate: string
}> {
  if (!rawTxBase64) return { status: 'invalid-request' }
  let currentShapeKeys: Set<string>
  let message: ReturnType<typeof parseSolanaMessage>
  try {
    const observed = observeSolanaTransaction({ rawTxBase64 })
    currentShapeKeys = new Set([observed.shapeKey, ...expandClearSignAuditDrafts(observed).map(value => value.shapeKey)])
    const full = Buffer.from(rawTxBase64, 'base64')
    message = parseSolanaMessage(solanaMessageSlice(full, parseSolanaTx(full)))
  } catch { return { status: 'invalid-request' } }
  // A reusable schema does not bind accounts loaded from an ALT. Firmware's
  // certified path requires an additional transaction-specific LUT proof.
  if (message.altEntries.length > 0) return { status: 'unsupported-alt' }
  let sawSolanaArtifact = false
  for (const { artifact, job } of snapshotProvider()) {
    if (artifact.chain !== 'Solana' || !artifact.solana) continue
    sawSolanaArtifact = true
    if (!currentShapeKeys.has(artifact.shapeKey)) continue
    if (artifact.revokedAt) return { status: 'revoked' }
    if (artifact.expiresAt <= Date.now()) return { status: 'expired' }
    const refusal = identityRefusal(job, artifact.identityHash)
    if (refusal) return { status: refusal }
    try {
      const inspected = inspectSolanaSchema(artifact.payloadHex)
      const program = Buffer.from(bs58.decode(inspected.draft.programId))
      const discriminator = Buffer.from(inspected.draft.discriminator, 'hex')
      const matches = message.instructions.filter(ix => {
        const programKey = message.staticAccounts[ix.programIdIndex]
        return Boolean(programKey) && Buffer.from(programKey).equals(program)
          && ix.data.length === inspected.coverageBytes
          && Buffer.from(ix.data.subarray(0, discriminator.length)).equals(discriminator)
          && inspected.draft.accounts.every(account => account.index < ix.accountIndices.length)
      })
      if (matches.length !== 1) continue
      return { status: 'selected', artifact: {
        bundleHash: artifact.bundleHash,
        label: `${inspected.draft.programName} · ${inspected.draft.instructionName}`,
        expiresAt: artifact.expiresAt,
        schema: { payload: artifact.solana.schemaPayloadHex, signature: artifact.solana.schemaSignatureHex, signerKeyId: 128 },
        certificate: artifact.solana.certificateHex,
      } }
    } catch { /* malformed persisted data is never selected */ }
  }
  return { status: sawSolanaArtifact ? 'shape-mismatch' : 'no-artifact' }
}
