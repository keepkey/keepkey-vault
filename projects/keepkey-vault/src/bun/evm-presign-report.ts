/**
 * One EVM verdict for both approval surfaces: the Desktop signing overlay and
 * the pre-sign POST /clearsign/report a browser extension shows. Both build the
 * overlay's SigningRequestInfo with prepareEvmTxSigningInfo and read the risk
 * lines from shared/clearsign-risk, so the same bytes get the same words.
 */
import type { ClearSignProtectionLevel, SigningRequestInfo } from '../shared/types'
import type { EffectFinding, EffectReport } from '../shared/transaction-effects'
import { buildClearSignReport, type ClearSignDescriptorEvidence, type ClearSignReport, type ContractRating } from '../shared/clearsign-report'
import { CERTIFIED_METADATA_KEY_ID } from './evm-certified-schema'
import { certifiedBodyRefused, certifiedEnvelopeShown, metadataPayloadBytes } from '../shared/certified-evm-envelope'
import { assessSigningRisk, type RiskLevel } from '../shared/clearsign-risk'
import { applyEvmTxPreview, attachErc7730Definition } from './evm-signing-preview'
import { measureLiveDeployment, resolveCertifiedEvmTransaction, resolveEvmSchema } from './evm-schema-registry'
import { supportsCertifiedClearSign } from './solana-certified-policy'
import { resolvePromotedEvmArtifact, type ClearSignArtifactResolution } from './clearsign-artifact-resolver'
import { simulateEvmEffects } from './evm-effects'
import { uniswapReportFindingsWithState } from './uniswap-report'
import { findContractRating } from './clearsign-review'

/**
 * The Desktop's pre-approval EVM preview: local decode + firmware gates
 * (applyEvmTxPreview), then — still blind — promoted local artifacts and
 * certified exact-transaction envelopes. Resolved before approval and kept on
 * signingInfo so the handler signs what the user reviewed. A lookup failure
 * leaves the call on the blind / AdvancedMode path.
 */
export async function prepareEvmTxSigningInfo(
  signingInfo: SigningRequestInfo, preview: any, firmwareVersion: string | undefined,
  capabilities?: readonly number[],
): Promise<void> {
  await applyEvmTxPreview(
    signingInfo, preview.to, preview.data, signingInfo.chainId as number | undefined,
    firmwareVersion, preview.txMetadata,
  )
  if (signingInfo.needsBlindSigning && preview.data && preview.data.length >= 10 && preview.to
    && !preview.txMetadata?.signedPayload && supportsCertifiedClearSign(signingInfo.firmwareVersion)) {
    const chainIdNum = Number(signingInfo.chainId)
    try {
      const txForCertification = {
        chainId: chainIdNum, from: preview.from, to: preview.to, data: preview.data,
        value: preview.value || '0x0', nonce: preview.nonce || '0x0',
        gasLimit: preview.gas || preview.gasLimit || '0x5208',
        ...(preview.gasPrice || preview.gas_price ? { gasPrice: preview.gasPrice || preview.gas_price } : {
          maxFeePerGas: preview.maxFeePerGas || preview.max_fee_per_gas,
          maxPriorityFeePerGas: preview.maxPriorityFeePerGas || preview.max_priority_fee_per_gas || '0x0',
        }),
      }
      const found = await resolveEvmSchema(chainIdNum, preview.to, preview.data, true, signingInfo.firmwareVersion)
        ?? await resolveCertifiedEvmTransaction(txForCertification)
      // The swap gate's rule (evmCallRequiresAdvancedMode): relax only for an
      // envelope this firmware shows for this exact call. A body it refuses
      // (0x04 on 7.16.0) is dropped, so the device shows its normal review.
      const certified = found && !certifiedBodyRefused(found.signedPayload, signingInfo.firmwareVersion)
        && certifiedEnvelopeShown(metadataPayloadBytes(found.signedPayload), found.keyId, signingInfo.firmwareVersion,
          { chainId: chainIdNum, to: preview.to, data: preview.data })
        ? found : undefined
      if (found && !certified) console.warn(`[REST] Certified "${found.method}" is not shown by firmware ${signingInfo.firmwareVersion} for this call — not attached`)
      if (certified) {
        signingInfo.certifiedEvmSchema = certified
        signingInfo.deviceClearSigns = true
        signingInfo.needsBlindSigning = false
        console.log(`[REST] Approval preview authenticated by certified schema ${certified.method} (source=${certified.source || 'service'})`)
      }
    } catch (error: any) {
      console.warn(`[REST] Certified approval preview unavailable, staying blind: ${error?.message || error}`)
    }
  }
  // Last: a ClearSign service ERC-7730 definition, only when nothing above
  // describes the call (kind-1 wins; one description per transaction).
  if (!preview.txMetadata?.signedPayload) await attachErc7730Definition(signingInfo, preview.to, preview.data, firmwareVersion, capabilities)
}

/** A transfer with no call data. Every firmware shows its amount and
 *  destination itself, so it needs no description and no AdvancedMode. */
export function isPlainEvmTransfer(info: Pick<SigningRequestInfo, 'to' | 'data'>): boolean {
  return Boolean(info.to) && (!info.data || info.data === '0x')
}

/**
 * A name for the call when a reviewed, pinned local decoder read all of it:
 * a Universal Router swap at a reviewed router that decodes the way the device
 * decodes it (the swap rows uniswapSwapFields adds), or an Across depositV3 to
 * a pinned SpokePool. Says nothing about what the DEVICE will show.
 */
export function reviewedEvmDecodeLabel(info: SigningRequestInfo): string | undefined {
  const d = info.calldataDecoded
  if (!d || d.source !== 'local') return undefined
  const field = (n: string) => d.fields.find((f) => f.name === n)?.value
  if (field('Protocol') === 'Uniswap Universal Router' && field('Action')?.startsWith('Swap ')) return 'Uniswap Universal Router swap'
  if (d.dappName === 'Across' && d.functionType === 'bridge') return 'Across bridge deposit'
  if (d.dappName === 'Relay' && d.functionType === 'bridge') return 'Relay deposit'
  // calldata-decoder names THORChain/Maya only for a pinned router on this chain.
  if ((d.dappName === 'THORChain' || d.dappName === 'Mayachain') && field('Action')) return `${d.dappName} deposit`
  return undefined
}

/**
 * The Desktop signing overlay's own verdict for a prepared EVM tx: P4 when the
 * device decodes it natively or a certified envelope (keyId 0x80) is attached
 * that the device verifies before it shows the call; otherwise host evidence
 * only. The overlay and the in-app swap card both use this, so a call Desktop
 * signs with a certified description reads the same on both. `preview` is the
 * request as the signer will send it (its txMetadata is a caller blob).
 */
export function evmSigningVerdict(
  info: SigningRequestInfo, preview: { txMetadata?: { signedPayload?: unknown; keyId?: unknown } },
  simulation: EffectReport, universalRouterComplete: boolean,
): { requestedLevel: ClearSignProtectionLevel; descriptor: ClearSignDescriptorEvidence } {
  const certified = info.certifiedEvmSchema
  // applyEvmTxPreview attaches a certified envelope as the decoded blob
  // (keyId 0x80) instead of certifiedEvmSchema; it is the same
  // device-verified description.
  const certifiedBlob = !certified && !preview.txMetadata?.signedPayload
    && info.calldataDecoded?.insightKeyId === CERTIFIED_METADATA_KEY_ID
  const plain = isPlainEvmTransfer(info)
  // A ClearSign service ERC-7730 definition the preview fetched and checked for
  // this exact call: the device verifies it and shows the call from it. Never
  // beside kind-1 metadata, which wins.
  const erc7730 = !certified && !certifiedBlob && !preview.txMetadata?.signedPayload && Boolean(info.erc7730)
  const deviceAuthenticated = info.deviceClearSigns === true || certifiedBlob || plain || erc7730
  // A caller's runtime-signer blob: name the device slot its signer sits in.
  const callerKeyId = Number(preview.txMetadata?.keyId)
  const provider = preview.txMetadata?.signedPayload && Number.isInteger(callerKeyId) && callerKeyId >= 1 && callerKeyId <= 3
    ? { keyId: callerKeyId, status: 'supplied' as const } : undefined
  return {
    requestedLevel: deviceAuthenticated ? 'P4' : hostEvidenceLevel(simulation, universalRouterComplete, info),
    descriptor: {
      source: certified || certifiedBlob ? 'certified' : erc7730 ? 'erc7730' : deviceAuthenticated ? 'native' : preview.txMetadata ? 'runtime' : 'none',
      authenticated: deviceAuthenticated,
      format: certified || certifiedBlob ? 'EVM_METADATA' : erc7730 ? 'ERC7730' : deviceAuthenticated ? 'FIRMWARE_NATIVE' : preview.txMetadata ? 'EVM_METADATA' : undefined,
      label: certified?.method || (certifiedBlob ? info.calldataDecoded?.method : undefined) || (plain ? 'a plain transfer' : undefined) || (deviceAuthenticated ? `${info.calldataDecoded?.dappName || 'EVM'} ${info.calldataDecoded?.method || 'call'}` : reviewedEvmDecodeLabel(info)),
      ...(provider ? { provider } : {}),
      ...(erc7730 && info.erc7730Description?.signedBy ? { signer: info.erc7730Description.signedBy } : {}),
    },
  }
}

/** Report entries buildClearSignReport derives itself (from the simulation
 *  and the descriptor); a rebuilt report must not carry them twice. */
const DERIVED_REPORT_CODES = new Set(['ASSETS_LEAVE_WALLET', 'AUTHORITY_GRANTED', 'CLEARSIGN_DEFINITION_REFUSED'])

/**
 * The overlay info once the device has refused its ERC-7730 definition. The
 * call is signed without it, so the card reads as the blind call it now is and
 * asks for the normal blind-sign / AdvancedMode handling (a new card id).
 */
export function withoutErc7730Description(info: SigningRequestInfo): SigningRequestInfo {
  const { erc7730: _refused, erc7730Description: _shown, ...rest } = info
  const next: SigningRequestInfo = { ...rest, id: `${info.id}:without-erc7730`, needsBlindSigning: true }
  const report = info.clearSignReport
  if (report) {
    const sim = report.simulation
    const fromSimulation = new Set<unknown>([...sim.warnings, ...sim.unknowns])
    const keep = (f: EffectFinding) => !fromSimulation.has(f) && !DERIVED_REPORT_CODES.has(f.code)
    next.clearSignReport = buildClearSignReport({
      requestedLevel: hostEvidenceLevel(sim, false, next),
      descriptor: { source: 'none', authenticated: false, label: reviewedEvmDecodeLabel(next), resolution: report.descriptor.resolution },
      simulation: sim,
      hostFindings: report.findings.filter(keep),
      hostLimitations: [...report.limitations.filter(keep), {
        code: 'ERC7730_DEFINITION_REFUSED',
        message: 'Your KeepKey could not show this call from its ClearSign description. It shows raw data instead.',
        severity: 'danger',
      }],
      rating: report.rating,
    })
  }
  return next
}

/** Pre-sign level from host evidence only; P4 is never reachable here. */
export function hostEvidenceLevel(
  simulation: EffectReport, universalRouterComplete: boolean, info: SigningRequestInfo,
): ClearSignProtectionLevel {
  if (simulation.status === 'success') return 'P3'
  return universalRouterComplete || reviewedEvmDecodeLabel(info) ? 'P2' : 'P1'
}

const RISK_SEVERITY: Record<RiskLevel, EffectFinding['severity']> = {
  low: 'info', medium: 'warning', high: 'danger', critical: 'danger',
}

/**
 * POST /clearsign/report for an EVM tx, from a signingInfo already prepared by
 * prepareEvmTxSigningInfo. Findings lead with the Desktop risk bar's own
 * sentences (verbatim), then the decoded rows the Desktop card shows.
 */
export function buildEvmPresignReport(input: {
  signingInfo: SigningRequestInfo
  deviceConnected: boolean
  simulation: EffectReport
  universalRouterFindings: { complete: boolean; findings: EffectFinding[]; limitations: EffectFinding[] }
  artifactResolution: ClearSignArtifactResolution<{ bundleHash: string; method: string; expiresAt: number }>
  rating?: ContractRating
  /**
   * In-app only: this Desktop is the signer and sends exactly the prepared
   * request, so the report takes the signing overlay's verdict
   * (evmSigningVerdict). An external caller (POST /clearsign/report) gets P4
   * only for a call the firmware shows natively: a descriptor is verified only
   * by the device at signing.
   */
  signerVerdict?: boolean
}): ClearSignReport {
  const { signingInfo: info, simulation, universalRouterFindings: ur, artifactResolution } = input
  const promoted = artifactResolution.status === 'selected' ? artifactResolution.artifact : undefined
  const reviewed = reviewedEvmDecodeLabel(info)
  const resolution = !promoted && reviewed && artifactResolution.status === 'no-artifact' ? 'reviewed-decoder' as const : artifactResolution.status
  // A plain transfer, or a call the firmware decodes itself (an ERC-20 transfer
  // of a token in its table), has no descriptor to wait for: the device shows
  // it whoever asks.
  const firmwareNative = info.deviceClearSigns === true && !info.certifiedEvmSchema
    && info.calldataDecoded?.insightKeyId !== CERTIFIED_METADATA_KEY_ID
  const verdict = input.signerVerdict || isPlainEvmTransfer(info) || firmwareNative ? evmSigningVerdict(info, {}, simulation, ur.complete) : undefined
  const report = buildClearSignReport({
    // A supplied descriptor becomes P4 only after the device verifies it
    // during signing. This pre-sign report never self-promotes.
    requestedLevel: verdict?.requestedLevel ?? hostEvidenceLevel(simulation, ur.complete, info),
    descriptor: verdict ? { ...verdict.descriptor, resolution: verdict.descriptor.authenticated ? artifactResolution.status : resolution } : {
      source: promoted ? 'certified' : info.erc7730 ? 'erc7730' : 'none',
      authenticated: false,
      format: promoted ? 'EVM_METADATA' : info.erc7730 ? 'ERC7730' : undefined,
      label: promoted?.method ?? reviewed,
      artifactHash: promoted?.bundleHash,
      codeIdentityBound: Boolean(promoted),
      expiresAt: promoted?.expiresAt,
      resolution,
    },
    simulation,
    hostFindings: ur.findings,
    hostLimitations: ur.limitations,
    definitionReview: verdict ? info.certifiedEvmSchema?.definitionReview : undefined,
    rating: input.rating,
  })

  info.clearSignReport = report
  const risk = assessSigningRisk(info)
  const riskFindings: EffectFinding[] = (risk?.reasons ?? []).map((r) => ({
    code: `RISK_${r.level.toUpperCase()}`, message: r.text, severity: RISK_SEVERITY[r.level],
  }))
  const rows: EffectFinding[] = reviewed
    ? (info.calldataDecoded?.fields ?? []).map((f) => ({ code: 'DECODED_FIELD', message: `${f.name}: ${f.value}`, severity: 'info' as const }))
    : []
  report.findings.unshift(...riskFindings, ...rows)

  if (!input.deviceConnected) report.limitations.push({
    code: 'DEVICE_NOT_CONNECTED',
    message: 'No KeepKey is connected, so its firmware was not checked. This report assumes the device shows this call as raw data and needs Advanced Mode, unless the firmware decodes it natively.',
    severity: 'warning',
  })
  else if (info.needsBlindSigning) report.limitations.push({
    code: 'DEVICE_SHOWS_RAW_DATA',
    message: 'Your KeepKey cannot show this call: its screen shows raw data, and signing it requires Advanced Mode (blind signing) on the device.',
    severity: 'danger',
  })
  return report
}

export interface EvmReportTx {
  chainId: number
  from: string
  to?: string
  data?: string
  value?: string
  gas?: string
  gasLimit?: string
  gasPrice?: string
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
  nonce?: string
}

/**
 * Prepare + simulate + report one EVM tx: what POST /clearsign/report and the
 * in-app swap card run, so both read the same bytes the way the Desktop
 * signing path does. `signerVerdict` as in buildEvmPresignReport.
 */
export async function buildEvmReportForTx(input: {
  tx: EvmReportTx
  firmwareVersion: string | undefined
  /** Features.capabilities of the connected device (the ERC-7730 gate). */
  capabilities?: readonly number[]
  endpoint: string
  signerVerdict?: boolean
  measure?: typeof measureLiveDeployment
}): Promise<{ report: ClearSignReport; signingInfo: SigningRequestInfo; simulation: EffectReport; artifactResolution: ReturnType<typeof resolvePromotedEvmArtifact> }> {
  const { tx, firmwareVersion, endpoint } = input
  const data = tx.data || '0x'
  const artifactResolution = resolvePromotedEvmArtifact(tx.chainId, tx.to, data)
  const simulation = await simulateEvmEffects({
    chainId: tx.chainId, from: tx.from, to: tx.to, data, value: tx.value || '0x0',
    gas: tx.gas || tx.gasLimit, gasPrice: tx.gasPrice,
    maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, nonce: tx.nonce,
  }, endpoint)
  const universalRouterFindings = await uniswapReportFindingsWithState(data, tx.chainId, tx.to, tx.from, endpoint)
  const signingInfo: SigningRequestInfo = {
    id: 'report', method: '/eth/sign-transaction', appName: 'report', chain: 'eth',
    from: tx.from, to: tx.to, value: tx.value, chainId: tx.chainId, data, firmwareVersion,
  }
  // The request as a dapp would send it: no caller metadata, so the shared
  // preview resolves certified envelopes itself, as the signing path does.
  await prepareEvmTxSigningInfo(signingInfo, { ...tx, data }, firmwareVersion, input.capabilities)
  const report = buildEvmPresignReport({
    signingInfo,
    deviceConnected: Boolean(firmwareVersion),
    simulation,
    universalRouterFindings,
    artifactResolution,
    signerVerdict: input.signerVerdict,
    rating: tx.to ? await findContractRating(tx.chainId, tx.to, input.measure ?? measureLiveDeployment) : undefined,
  })
  return { report, signingInfo, simulation, artifactResolution }
}
