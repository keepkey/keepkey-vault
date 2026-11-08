import { expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChakraProvider, defaultSystem } from '@chakra-ui/react'
import type { ClearSignReport } from '../../shared/clearsign-report'

test('shows attributed assessment separately from the clear-signing result', async () => {
  mock.module('../lib/rpc', () => ({ rpcRequest: async () => undefined }))
  const { ClearSignReportCard } = await import('./ClearSignReportCard')
  const report = {
    protectionLevel: 'P1', headline: 'Opaque transaction', transactionFingerprint: 'a'.repeat(64),
    simulation: { status: 'unavailable', stateReference: {}, assetChanges: [], authorityChanges: [] },
    findings: [], limitations: [],
    rating: { network: 'eip155:1', contract: '0x' + '11'.repeat(20), riskLevel: 'high',
      riskReasons: ['Single-key control'], findings: [{ severity: 'high', title: 'Upgradeable', detail: 'Admin can change code.', reference: 'audit:section-2' }],
      ratedAt: Date.UTC(2026, 8, 25), rater: '<Auditor>', source: 'hosted-assessment', reportUrl: 'https://clearsign.example/audits/0x' + 'aa'.repeat(32) },
  } as unknown as ClearSignReport
  const html = renderToStaticMarkup(<ChakraProvider value={defaultSystem}><ClearSignReportCard report={report} /></ChakraProvider>)
  for (const text of ['Contract audit assessment', '2026-09-25', '&lt;Auditor&gt;', 'audit:section-2', 'assessment is an opinion', 'More info', 'href="https://clearsign.example/audits/0x', 'Submitted by', 'data-clearsign-level="P1"']) {
    expect(html).toContain(text)
  }
  expect(html).not.toContain('Sign with')
  expect(html).not.toContain('rater is not yet pinned')
})
