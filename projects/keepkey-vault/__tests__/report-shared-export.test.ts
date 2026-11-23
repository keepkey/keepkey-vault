import { expect, test } from 'bun:test'
import type { ReportData, ReportSection } from '../src/shared/types'
import { reportToCsv, reportToPdfBuffer, SECTION_TITLES, UNKNOWN_BTC_FEE } from '../src/bun/reports'
import { extractTransactionsFromReport } from '../src/bun/tax-export'

const details = (fee: string, net = '0.00301000'): ReportSection => ({
  title: SECTION_TITLES.TX_DETAILS,
  type: 'table',
  data: {
    headers: ['TXID', 'Dir', 'Block', 'Date', 'Amount (BTC)', 'Fee (BTC)', 'From', 'To'],
    rows: [['shared-fixture', 'SENT', '1', '2026-11-22 12:00:00', net, fee, 'own', 'other']],
  },
})

function report(section: ReportSection): ReportData {
  return { title: 'Test Report', subtitle: '', generatedDate: '', sections: [section] }
}

test('a local full export preserves the signed net change and unknown fee', async () => {
  const data = report(details(UNKNOWN_BTC_FEE, '-0.00301000'))
  const csv = reportToCsv(data)
  expect(csv).toContain('-0.00301000')
  expect(csv).toContain(UNKNOWN_BTC_FEE)
  const pdf = await reportToPdfBuffer(data)
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
})

test('tax exports refuse a shared transaction in either report table layout', () => {
  const history: ReportSection = {
    title: SECTION_TITLES.TX_HISTORY,
    type: 'table',
    data: {
      headers: ['#', 'Dir', 'TXID', 'Block', 'Date', 'Amount (BTC)', 'Fee (BTC)'],
      rows: [['1', 'SENT', 'shared-fixture', '1', '2026-11-22 12:00:00', '-0.00301000', UNKNOWN_BTC_FEE]],
    },
  }
  for (const section of [details(UNKNOWN_BTC_FEE), history]) {
    expect(() => extractTransactionsFromReport(report(section))).toThrow('unknown fee shares')
  }
})

test('ordinary tax exports retain their amounts and fees', () => {
  expect(extractTransactionsFromReport(report(details('0.00001000')))).toMatchObject([
    { amountSent: 0.00301, feeAsset: 'BTC', feeAmount: 0.00001 },
  ])
})
