/** Audit v6 A6: the ledger CSV wrote txid, account and asset raw, so commas shifted columns and "=..." ran in Excel. */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'vault-ledger-csv-'))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData: dir } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData: dir } }))
const db = await import('../src/bun/db')
const { exportLedgerCsv, insertManualEntry } = await import('../src/bun/ledger')
const { csvCell, csvNumber } = await import('../src/bun/csv')
beforeAll(() => db.initDb())
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

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
/** What a spreadsheet would treat as a formula. */
const runsAsFormula = (cell: string) => /^[=+\-@\t\r\n]/.test(cell.trimStart())

describe('csv cells', () => {
  test('quote every cell and double inner quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell(null)).toBe('""')
  })
  test('neutralize anything a spreadsheet would run', () => {
    for (const value of ['=HYPERLINK("http://x","claim")', '+1+1', '-1+cmd', '@SUM(A1)', '\t=1', '\r=1', '\n=1', '  =1'])
      expect(csvCell(value)).toBe(`"'${value.replace(/"/g, '""')}"`)
  })
  test('plain numbers stay numbers, negative ones included; anything else is escaped', () => {
    expect(csvNumber('-0.500000000000')).toBe('-0.500000000000')
    expect(csvNumber('12')).toBe('12')
    expect(csvNumber('-1+cmd')).toBe(`"'-1+cmd"`)
    expect(csvNumber('1e5')).toBe('"1e5"')
  })
})

describe('ledger export', () => {
  test('hostile asset, txid, account and description cannot shift columns or run as formulas', () => {
    const asset = '=HYPERLINK("http://claim.example","Claim, now")'
    const id = insertManualEntry({
      deviceId: 'device-csv',
      description: '=cmd|" /C calc"!A0, "spam"',
      postings: [
        { accountId: 'Assets:eth,evil', accountType: 'asset', asset, chainId: 'ethereum', amount: 1.5 },
        { accountId: '@Income:airdrop', accountType: 'income', asset, chainId: 'ethereum', amount: -1.5 },
      ],
    })
    expect(id).toBeTruthy()
    const rows = parseCsv(exportLedgerCsv('device-csv'))
    expect(rows[0]).toEqual(['date', 'journal_entry_id', 'txid', 'entry_type', 'description', 'account_id', 'account_type', 'asset', 'amount'])
    const data = rows.slice(1)
    expect(data).toHaveLength(2)
    for (const row of data) {
      // Before the fix the comma in the asset and account split them, giving 11-12 columns.
      expect(row).toHaveLength(9)
      for (const cell of row.slice(0, 8)) expect(runsAsFormula(cell)).toBe(false)
      expect(row[7]).toBe(`'${asset}`)
      expect(row[4]).toBe(`'=cmd|" /C calc"!A0, "spam"`)
    }
    expect(data.map(row => row[5])).toEqual(['Assets:eth,evil', `'@Income:airdrop`])
    // Amounts stay numbers a spreadsheet can sum, negative included.
    expect(data.map(row => row[8])).toEqual(['1.500000000000', '-1.500000000000'])
  })
})
