import { Flex, Text } from '@chakra-ui/react'
import type { ClearSignReport, ContractRating } from '../../shared/clearsign-report'

export function ClearSignReportCard({ report, title = 'ClearSign Report' }: { report?: ClearSignReport; title?: string }) {
  if (!report) return null
  const color = report.protectionLevel === 'P4' || report.protectionLevel === 'P5' ? 'var(--teal)' : report.protectionLevel === 'P3' ? 'var(--gold)' : 'var(--rose)'
  const short = (value: string) => value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value
  return <Flex direction="column" gap="1.5" w="100%" bg="rgba(0,0,0,0.28)" border={`1px solid ${color}`} borderRadius="lg" px="3" py="2" data-clearsign-level={report.protectionLevel}>
    <Flex justify="space-between" align="center" gap="2"><Text fontSize="xs" fontWeight="800" color={color}>{title}</Text><Text fontSize="2xs" fontWeight="800" color={color}>{report.protectionLevel}</Text></Flex>
    <Text fontSize="xs" fontWeight="700" color="white">{report.headline}</Text>
    <Text fontSize="2xs" color="kk.textMuted">Simulation: {report.simulation.status} at {report.simulation.stateReference.blockOrSlot || 'provider head'}</Text>
    {report.simulation.assetChanges.map((change, index) => <Text key={`${change.asset.id}:${change.account}:${index}`} fontSize="xs" color={BigInt(change.delta) < 0n ? 'var(--rose)' : 'var(--teal)'}>{BigInt(change.delta) < 0n ? '−' : '+'}{BigInt(change.delta) < 0n ? change.delta.slice(1) : change.delta} raw units · {change.asset.symbol || short(change.asset.id)}</Text>)}
    {report.simulation.authorityChanges.map((change, index) => <Text key={`${change.kind}:${index}`} fontSize="xs" color={change.revoked ? 'kk.textSecondary' : 'var(--rose)'}>{change.revoked ? 'Revokes' : 'Grants'} {change.unlimited ? 'unlimited ' : ''}{change.kind} authority to {short(change.authority)}</Text>)}
    {report.findings.map((finding, index) => <Text key={`${finding.code}:${index}`} fontSize="2xs" color={finding.severity === 'danger' ? 'var(--rose)' : 'kk.textSecondary'}>• {finding.message}</Text>)}
    {report.limitations.map((finding, index) => <Text key={`${finding.code}:${index}`} fontSize="2xs" color="var(--gold)">Unknown: {finding.message}</Text>)}
    {report.definitionReview && <Text fontSize="2xs" color="kk.textMuted">
      Definition approved by separate semantics and security reviewers for the audited code ({report.definitionReview.auditedIdentities.map((item) => item.role).join(' + ')}).
      {!report.definitionReview.approversPinned && ' Approvers are not yet pinned in this Vault.'}
    </Text>}
    {report.rating && <ContractRatingView rating={report.rating} />}
    <Text fontSize="2xs" color="kk.textMuted" fontFamily="mono">Tx {report.transactionFingerprint.slice(0, 12)}… · Effects are predictions; the KeepKey verifies authenticated descriptions and signed bytes.</Text>
  </Flex>
}

const RISK_COLOR: Record<ContractRating['riskLevel'], string> = {
  low: 'var(--teal)', medium: 'var(--gold)', high: 'var(--rose)', critical: 'var(--rose)',
}

/** A human auditor's opinion of the contract. Separate from clearsign: this
 * app checks the signature; the KeepKey never sees or verifies it. */
function ContractRatingView({ rating }: { rating: ContractRating }) {
  const color = RISK_COLOR[rating.riskLevel]
  return <Flex direction="column" gap="1" mt="1" pt="1.5" borderTop="1px solid rgba(255,255,255,0.12)" data-contract-risk={rating.riskLevel}>
    <Flex justify="space-between" align="center" gap="2">
      <Text fontSize="xs" fontWeight="800" color="white">Auditor rating</Text>
      <Text fontSize="2xs" fontWeight="800" color={color} textTransform="uppercase">{rating.riskLevel} risk</Text>
    </Flex>
    {rating.riskReasons.map((reason, index) => <Text key={`reason:${index}`} fontSize="2xs" color={color}>• {reason}</Text>)}
    {rating.findings.map((finding, index) => <Text key={`finding:${index}`} fontSize="2xs" color="kk.textSecondary">
      <Text as="span" fontWeight="700" color={finding.severity === 'high' || finding.severity === 'critical' ? 'var(--rose)' : 'white'}>{finding.severity}: {finding.title}.</Text> {finding.detail}
    </Text>)}
    <Text fontSize="2xs" color="kk.textMuted">
      A human opinion of this contract, checked by this app — not by your KeepKey.
      {!rating.raterPinned && ' The rater is not yet pinned in this Vault.'}
    </Text>
  </Flex>
}
