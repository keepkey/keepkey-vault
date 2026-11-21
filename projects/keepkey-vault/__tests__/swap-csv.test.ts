/** Audit v6 A7: the swap history CSV quoted only cells with a comma, and never neutralized formulas. */
import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SwapHistoryRecord } from '../src/shared/types'

// swap-report reads settings from the app database, which needs the desktop runtime's paths.
const userData = mkdtempSync(join(tmpdir(), 'vault-swap-csv-'))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData } }))
const { generateSwapCsv } = await import('../src/bun/swap-report')

/** RFC 4180 reader, as a spreadsheet splits the file. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += c
  }
  row.push(cell); rows.push(row)
  return rows
}
const runsAsFormula = (cell: string) => /^[=+\-@\t\r\n]/.test(cell.trimStart())

const base: SwapHistoryRecord = { id: 's1', txid: '0xin', fromAsset: 'ETH.ETH', toAsset: 'BTC.BTC', fromSymbol: 'ETH', toSymbol: 'BTC',
  fromChainId: 'ethereum', toChainId: 'bitcoin', fromAmount: '1.5', quotedOutput: '0.05', minimumOutput: '0.049', receivedOutput: '0.0495',
  slippageBps: 100, feeBps: 0, feeOutbound: '0.0001', integration: 'thorchain', memo: '', inboundAddress: '', status: 'completed',
  createdAt: Date.UTC(2026, 10, 20), updatedAt: 1, estimatedTimeSeconds: 600, actualTimeSeconds: 540, outboundTxid: 'abc' }

describe('swap history CSV', () => {
  test('hostile symbols, error text and txids cannot run as formulas or shift columns', () => {
    const hostile: SwapHistoryRecord = { ...base, id: 's2', status: 'failed',
      toSymbol: '=HYPERLINK("http://claim.example","Claim, now")', toAsset: 'ETH.SPAM-0xdead',
      fromSymbol: '@SUM(1)', integration: '+cmd', txid: '-0xin,evil', outboundTxid: undefined, receivedOutput: undefined,
      actualTimeSeconds: undefined, error: '=cmd|" /C calc"!A0\nsecond line', quotedOutput: '=1+1', feeOutbound: '-1+cmd' }
    const rows = parseCsv(generateSwapCsv([base, hostile]))
    const header = rows[0]
    expect(header).toHaveLength(16)
    for (const row of rows.slice(1)) {
      // Before the fix, the comma-free hostile cells were written raw and ran as formulas.
      expect(row).toHaveLength(16)
      for (const cell of row) expect(runsAsFormula(cell)).toBe(false)
    }
    const bad = Object.fromEntries(header.map((name, i) => [name, rows[2][i]]))
    expect(bad['To Asset']).toBe(`'=HYPERLINK("http://claim.example","Claim, now") (ETH.SPAM-0xdead)`)
    expect(bad['From Asset']).toBe(`'@SUM(1) (ETH.ETH)`)
    expect(bad['Integration']).toBe(`'+cmd`)
    expect(bad['Inbound TXID']).toBe(`'-0xin,evil`)
    expect(bad['Error']).toBe(`'=cmd|" /C calc"!A0\nsecond line`)
    // A numeric column holding something that is not a plain number is escaped like text.
    expect(bad['Quoted Output']).toBe(`'=1+1`)
    expect(bad['Outbound Fee']).toBe(`'-1+cmd`)
    expect(bad['Received Output']).toBe('')
    expect(bad['Duration (s)']).toBe('')
  })

  test('numbers stay unquoted numbers a spreadsheet can sum', () => {
    const line = generateSwapCsv([base]).split('\n')[1]
    expect(line).toContain(',1.5,0.05,0.049,0.0495,100,0,0.0001,')
    expect(line).toContain(',540,')
    const row = parseCsv(generateSwapCsv([base]))[1]
    expect(row.slice(4, 11)).toEqual(['1.5', '0.05', '0.049', '0.0495', '100', '0', '0.0001'])
  })
})
