/**
 * One EVM verdict for both approval surfaces: the Desktop signing overlay and
 * the pre-sign POST /clearsign/report a browser extension shows. Both build the
 * overlay's SigningRequestInfo with prepareEvmTxSigningInfo and read the risk
 * lines from shared/clearsign-risk, so the same bytes get the same words.
 */
import type { ClearSignProtectionLevel, SigningRequestInfo } from '../shared/types'
import type { EffectFinding, EffectReport } from '../shared/transaction-effects'
import { buildClearSignReport, type ClearSignDescriptorEvidence, type ClearSignReport, type ContractRating } from '../shared/clearsign-report'
import { ERC7730_TRANSPORT_SUPPORTED } from '../shared/erc7730-support'
import { CERTIFIED_METADATA_KEY_ID } from './evm-certified-schema'
import { assessSigningRisk, type RiskLevel } from '../shared/clearsign-risk'
import { applyEvmTxPreview } from './evm-signing-preview'
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
      const certified = await resolveEvmSchema(chainIdNum, preview.to, preview.data, true)
        ?? await resolveCertifiedEvmTransaction(txForCertification)
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
  info: SigningRequestInfo, preview: { txMetadata?: { signedPayload?: unknown }; erc7730?: unknown },
  simulation: EffectReport, universalRouterComplete: boolean,
): { requestedLevel: ClearSignProtectionLevel; descriptor: ClearSignDescriptorEvidence } {
  const certified = info.certifiedEvmSchema
  // applyEvmTxPreview attaches a certified envelope as the decoded blob
  // (keyId 0x80) instead of certifiedEvmSchema; it is the same
  // device-verified description.
  const certifiedBlob = !certified && !preview.txMetadata?.signedPayload
    && info.calldataDecoded?.insightKeyId === CERTIFIED_METADATA_KEY_ID
  const deviceAuthenticated = info.deviceClearSigns === true || certifiedBlob
  const erc7730 = ERC7730_TRANSPORT_SUPPORTED && Boolean(preview.erc7730)
  return {
    requestedLevel: deviceAuthenticated ? 'P4' : hostEvidenceLevel(simulation, universalRouterComplete, info),
    descriptor: {
      source: certified || certifiedBlob ? 'certified' : deviceAuthenticated ? 'native' : erc7730 ? 'erc7730' : preview.txMetadata ? 'runtime' : 'none',
      authenticated: deviceAuthenticated,
      format: certified || certifiedBlob ? 'EVM_METADATA' : deviceAuthenticated ? 'FIRMWARE_NATIVE' : erc7730 ? 'ERC7730' : preview.txMetadata ? 'EVM_METADATA' : undefined,
      label: certified?.method || (certifiedBlob ? info.calldataDecoded?.method : undefined) || (deviceAuthenticated ? `${info.calldataDecoded?.dappName || 'EVM'} ${info.calldataDecoded?.method || 'call'}` : reviewedEvmDecodeLabel(info)),
    },
  }
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
  hasErc7730?: boolean
  rating?: ContractRating
  /**
   * In-app only: this Desktop is the signer and sends exactly the prepared
   * request, so the report takes the signing overlay's verdict
   * (evmSigningVerdict). An external caller (POST /clearsign/report) never
   * gets P4 here: its descriptor is verified only by the device at signing.
   */
  signerVerdict?: boolean
}): ClearSignReport {
  const { signingInfo: info, simulation, universalRouterFindings: ur, artifactResolution } = input
  const promoted = artifactResolution.status === 'selected' ? artifactResolution.artifact : undefined
  const reviewed = reviewedEvmDecodeLabel(info)
  const resolution = !promoted && reviewed && artifactResolution.status === 'no-artifact' ? 'reviewed-decoder' as const : artifactResolution.status
  const verdict = input.signerVerdict ? evmSigningVerdict(info, {}, simulation, ur.complete) : undefined
  const report = buildClearSignReport({
    // A supplied descriptor becomes P4 only after the device verifies it
    // during signing. This pre-sign report never self-promotes.
    requestedLevel: verdict?.requestedLevel ?? hostEvidenceLevel(simulation, ur.complete, info),
    descriptor: verdict ? { ...verdict.descriptor, resolution: verdict.descriptor.authenticated ? artifactResolution.status : resolution } : {
      source: promoted ? 'certified' : input.hasErc7730 ? 'erc7730' : 'none',
      authenticated: false,
      format: promoted ? 'EVM_METADATA' : input.hasErc7730 ? 'ERC7730' : undefined,
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
  endpoint: string
  hasErc7730?: boolean
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
  await prepareEvmTxSigningInfo(signingInfo, { ...tx, data }, firmwareVersion)
  const report = buildEvmPresignReport({
    signingInfo,
    deviceConnected: Boolean(firmwareVersion),
    simulation,
    universalRouterFindings,
    artifactResolution,
    hasErc7730: input.hasErc7730,
    signerVerdict: input.signerVerdict,
    rating: tx.to ? await findContractRating(tx.chainId, tx.to, input.measure ?? measureLiveDeployment) : undefined,
  })
  return { report, signingInfo, simulation, artifactResolution }
}
