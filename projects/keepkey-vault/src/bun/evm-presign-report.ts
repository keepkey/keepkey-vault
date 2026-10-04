/**
 * One EVM verdict for both approval surfaces: the Desktop signing overlay and
 * the pre-sign POST /clearsign/report a browser extension shows. Both build the
 * overlay's SigningRequestInfo with prepareEvmTxSigningInfo and read the risk
 * lines from shared/clearsign-risk, so the same bytes get the same words.
 */
import type { ClearSignProtectionLevel, SigningRequestInfo } from '../shared/types'
import type { EffectFinding, EffectReport } from '../shared/transaction-effects'
import { buildClearSignReport, type ClearSignReport, type ContractRating } from '../shared/clearsign-report'
import { assessSigningRisk, type RiskLevel } from '../shared/clearsign-risk'
import { applyEvmTxPreview } from './evm-signing-preview'
import { resolveCertifiedEvmTransaction, resolveEvmSchema } from './evm-schema-registry'
import { supportsCertifiedClearSign } from './solana-certified-policy'
import type { ClearSignArtifactResolution } from './clearsign-artifact-resolver'

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
  return undefined
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
}): ClearSignReport {
  const { signingInfo: info, simulation, universalRouterFindings: ur, artifactResolution } = input
  const promoted = artifactResolution.status === 'selected' ? artifactResolution.artifact : undefined
  const reviewed = reviewedEvmDecodeLabel(info)
  const report = buildClearSignReport({
    // A supplied descriptor becomes P4 only after the device verifies it
    // during signing. This pre-sign report never self-promotes.
    requestedLevel: hostEvidenceLevel(simulation, ur.complete, info),
    descriptor: {
      source: promoted ? 'certified' : input.hasErc7730 ? 'erc7730' : 'none',
      authenticated: false,
      format: promoted ? 'EVM_METADATA' : input.hasErc7730 ? 'ERC7730' : undefined,
      label: promoted?.method ?? reviewed,
      artifactHash: promoted?.bundleHash,
      codeIdentityBound: Boolean(promoted),
      expiresAt: promoted?.expiresAt,
      resolution: !promoted && reviewed && artifactResolution.status === 'no-artifact' ? 'reviewed-decoder' : artifactResolution.status,
    },
    simulation,
    hostFindings: ur.findings,
    hostLimitations: ur.limitations,
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
