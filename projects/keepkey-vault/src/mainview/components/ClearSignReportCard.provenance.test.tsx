import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChakraProvider, defaultSystem } from '@chakra-ui/react'
import { ClearSignReportCard } from './ClearSignReportCard'
import type { ClearSignReport } from '../../shared/clearsign-report'

test('hosted assessments do not inherit signature or pinning claims', () => {
  const report = {
    protectionLevel: 'P1', headline: 'Opaque transaction', transactionFingerprint: 'a'.repeat(64),
    simulation: { status: 'unavailable', stateReference: {}, assetChanges: [], authorityChanges: [] },
    findings: [], limitations: [],
    rating: { network: 'eip155:1', contract: '0x' + '11'.repeat(20), riskLevel: 'high',
      riskReasons: ['Single-key control'], findings: [], ratedAt: 1_790_000_000_000,
      rater: 'Publisher supplied', source: 'hosted-assessment', reportUrl: 'https://example.test/audits/0x' + 'aa'.repeat(32) },
  } as unknown as ClearSignReport
  const html = renderToStaticMarkup(<ChakraProvider value={defaultSystem}><ClearSignReportCard report={report} /></ChakraProvider>)
  expect(html).toContain('data-contract-risk="high"')
  expect(html).not.toContain('The rater is not yet pinned')
  expect(html).not.toContain('checked by this app')
})
