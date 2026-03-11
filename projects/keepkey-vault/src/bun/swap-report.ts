/**
 * Swap Report Generator — PDF and CSV export for swap history.
 *
 * Uses pdf-lib (same as reports.ts) for PDF generation.
 * CSV is plain-text, compatible with spreadsheet apps and tax tools.
 */
import type { SwapHistoryRecord } from '../shared/types'

// ── CSV Export ────────────────────────────────────────────────────────

const CSV_HEADERS = [
  'Date', 'Status', 'From Asset', 'To Asset', 'Amount Sent', 'Quoted Output',
  'Minimum Output', 'Received Output', 'Slippage (bps)', 'Fee (bps)',
  'Outbound Fee', 'Integration', 'Inbound TXID', 'Outbound TXID',
  'Duration (s)', 'Error',
]

function csvEscape(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return `"${val.replace(/"/g, '""')}"`
  }
  return val
}

export function generateSwapCsv(records: SwapHistoryRecord[]): string {
  const lines = [CSV_HEADERS.join(',')]

  for (const r of records) {
    const row = [
      new Date(r.createdAt).toISOString(),
      r.status,
      `${r.fromSymbol} (${r.fromAsset})`,
      `${r.toSymbol} (${r.toAsset})`,
      r.fromAmount,
      r.quotedOutput,
      r.minimumOutput,
      r.receivedOutput || '',
      String(r.slippageBps),
      String(r.feeBps),
      r.feeOutbound,
      r.integration,
      r.txid,
      r.outboundTxid || '',
      r.actualTimeSeconds !== undefined ? String(r.actualTimeSeconds) : '',
      r.error || '',
    ]
    lines.push(row.map(csvEscape).join(','))
  }

  return lines.join('\n')
}

// ── PDF Export ────────────────────────────────────────────────────────

// Status colors for the PDF
const STATUS_COLORS: Record<string, { r: number; g: number; b: number }> = {
  completed: { r: 0.18, g: 0.71, b: 0.35 },
  failed: { r: 0.85, g: 0.20, b: 0.20 },
  refunded: { r: 0.93, g: 0.55, b: 0.17 },
  pending: { r: 0.95, g: 0.73, b: 0.13 },
  confirming: { r: 0.22, g: 0.50, b: 0.92 },
}

function sanitize(text: string): string {
  return text.replace(/[^\x20-\x7E]/g, '?')
}

export async function generateSwapPdf(records: SwapHistoryRecord[]): Promise<Buffer> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')

  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  // Landscape Letter
  const pageW = 792
  const pageH = 612
  const ML = 40  // margin left
  const MR = 40  // margin right
  const MT = 50  // margin top
  const MB = 50  // margin bottom
  const contentW = pageW - ML - MR

  let page = doc.addPage([pageW, pageH])
  let pageNum = 1
  let y = pageH - MT

  function newPage() {
    page.drawText(`Page ${pageNum}`, {
      x: pageW / 2 - 20, y: 25, font, size: 9,
      color: rgb(0.5, 0.5, 0.5),
    })
    page = doc.addPage([pageW, pageH])
    pageNum++
    y = pageH - MT
  }

  function needSpace(needed: number) {
    if (y - needed < MB) newPage()
  }

  function drawText(text: string, x: number, yPos: number, f: any, s: number, c: { r: number; g: number; b: number }, maxW?: number) {
    let t = sanitize(text)
    if (maxW && f.widthOfTextAtSize(t, s) > maxW) {
      let lo = 0, hi = t.length
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (f.widthOfTextAtSize(t.slice(0, mid), s) <= maxW) lo = mid
        else hi = mid - 1
      }
      if (lo < t.length && lo > 2) t = t.slice(0, lo - 2) + '..'
    }
    if (!t) return
    try {
      page.drawText(t, { x, y: yPos, font: f, size: s, color: rgb(c.r, c.g, c.b) })
    } catch { /* skip unprintable */ }
  }

  const white = { r: 1, g: 1, b: 1 }
  const gray = { r: 0.5, g: 0.5, b: 0.5 }
  const dark = { r: 0.15, g: 0.15, b: 0.15 }
  const brand = { r: 0.14, g: 0.86, b: 0.78 }

  // ── Title Page ──────────────────────────────────────────────────
  drawText('KeepKey Vault', ML, y, bold, 22, dark)
  y -= 28
  drawText('Swap History Report', ML, y, bold, 16, brand)
  y -= 20
  drawText(`Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`, ML, y, font, 10, gray)
  y -= 14
  drawText(`Total Records: ${records.length}`, ML, y, font, 10, gray)
  y -= 30

  // ── Summary Stats ───────────────────────────────────────────────
  const completed = records.filter(r => r.status === 'completed').length
  const failed = records.filter(r => r.status === 'failed').length
  const refunded = records.filter(r => r.status === 'refunded').length
  const pending = records.length - completed - failed - refunded

  needSpace(60)
  drawText('Summary', ML, y, bold, 13, dark)
  y -= 18

  const stats = [
    `Completed: ${completed}`,
    `Failed: ${failed}`,
    `Refunded: ${refunded}`,
    `Pending/In-Progress: ${pending}`,
  ]
  for (const s of stats) {
    drawText(s, ML + 10, y, font, 10, dark)
    y -= 14
  }
  y -= 16

  // ── Swap Table ──────────────────────────────────────────────────
  // Columns: Date | Pair | Sent | Quoted | Received | Status | Duration | Integration
  const cols = [
    { label: 'Date',        w: 105 },
    { label: 'Pair',        w: 90 },
    { label: 'Sent',        w: 80 },
    { label: 'Quoted Out',  w: 80 },
    { label: 'Received',    w: 80 },
    { label: 'Status',      w: 75 },
    { label: 'Duration',    w: 65 },
    { label: 'Integration', w: 65 },
  ]

  // Header row
  needSpace(30)
  page.drawRectangle({ x: ML, y: y - 4, width: contentW, height: 18, color: rgb(0.12, 0.12, 0.15) })
  let colX = ML + 4
  for (const col of cols) {
    drawText(col.label, colX, y, bold, 8, { r: 0.85, g: 0.85, b: 0.85 })
    colX += col.w
  }
  y -= 20

  // Data rows
  for (const r of records) {
    needSpace(18)

    // Alternate row shading
    const rowIdx = records.indexOf(r)
    if (rowIdx % 2 === 0) {
      page.drawRectangle({ x: ML, y: y - 4, width: contentW, height: 16, color: rgb(0.96, 0.96, 0.97) })
    }

    colX = ML + 4

    // Date
    const dateStr = new Date(r.createdAt).toLocaleString('en-US', {
      month: '2-digit', day: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
    drawText(dateStr, colX, y, font, 8, dark, cols[0].w - 6)
    colX += cols[0].w

    // Pair
    drawText(`${r.fromSymbol} -> ${r.toSymbol}`, colX, y, font, 8, dark, cols[1].w - 6)
    colX += cols[1].w

    // Sent
    drawText(r.fromAmount, colX, y, font, 8, dark, cols[2].w - 6)
    colX += cols[2].w

    // Quoted Out
    drawText(r.quotedOutput, colX, y, font, 8, dark, cols[3].w - 6)
    colX += cols[3].w

    // Received
    const recvColor = r.receivedOutput ? dark : gray
    drawText(r.receivedOutput || '-', colX, y, font, 8, recvColor, cols[4].w - 6)
    colX += cols[4].w

    // Status
    const sColor = STATUS_COLORS[r.status] || gray
    drawText(r.status, colX, y, bold, 8, sColor, cols[5].w - 6)
    colX += cols[5].w

    // Duration
    const durStr = r.actualTimeSeconds !== undefined
      ? (r.actualTimeSeconds < 60 ? `${r.actualTimeSeconds}s` : `${Math.floor(r.actualTimeSeconds / 60)}m ${r.actualTimeSeconds % 60}s`)
      : '-'
    drawText(durStr, colX, y, font, 8, dark, cols[6].w - 6)
    colX += cols[6].w

    // Integration
    drawText(r.integration, colX, y, font, 8, gray, cols[7].w - 6)

    y -= 16
  }

  // ── Detail Pages (one per swap) ─────────────────────────────────
  for (const r of records) {
    newPage()

    drawText(`Swap Detail: ${r.fromSymbol} -> ${r.toSymbol}`, ML, y, bold, 14, dark)
    y -= 22

    const sColor = STATUS_COLORS[r.status] || gray
    drawText(`Status: ${r.status}`, ML, y, bold, 11, sColor)
    y -= 18

    const details: [string, string][] = [
      ['Date', new Date(r.createdAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'],
      ['From', `${r.fromAmount} ${r.fromSymbol} (${r.fromAsset})`],
      ['To (Quoted)', `${r.quotedOutput} ${r.toSymbol}`],
      ['To (Minimum)', `${r.minimumOutput} ${r.toSymbol}`],
      ['To (Received)', r.receivedOutput ? `${r.receivedOutput} ${r.toSymbol}` : 'N/A'],
      ['Slippage Tolerance', `${r.slippageBps} bps (${(r.slippageBps / 100).toFixed(1)}%)`],
      ['Fee', `${r.feeBps} bps`],
      ['Outbound Fee', r.feeOutbound],
      ['Integration', r.integration],
      ['Inbound TX', r.txid],
      ['Outbound TX', r.outboundTxid || 'N/A'],
      ['Vault Address', r.inboundAddress],
      ['Router', r.router || 'N/A'],
      ['Est. Time', `${r.estimatedTimeSeconds}s`],
      ['Actual Time', r.actualTimeSeconds !== undefined ? `${r.actualTimeSeconds}s` : 'N/A'],
    ]

    if (r.approvalTxid) {
      details.push(['Approval TX', r.approvalTxid])
    }

    if (r.error) {
      details.push(['Error', r.error])
    }

    if (r.memo) {
      details.push(['Memo', r.memo])
    }

    for (const [label, value] of details) {
      needSpace(16)
      drawText(`${label}:`, ML + 6, y, bold, 9, dark)
      drawText(value, ML + 120, y, font, 9, label === 'Error' ? STATUS_COLORS.failed : dark, contentW - 130)
      y -= 14
    }

    // Quoted vs Received comparison (for completed swaps)
    if (r.status === 'completed' && r.receivedOutput && r.quotedOutput) {
      y -= 10
      needSpace(40)
      const quoted = parseFloat(r.quotedOutput)
      const received = parseFloat(r.receivedOutput)
      if (quoted > 0 && received > 0) {
        const diff = received - quoted
        const pctDiff = ((diff / quoted) * 100).toFixed(2)
        const diffColor = diff >= 0 ? STATUS_COLORS.completed : STATUS_COLORS.failed
        drawText('Quote Accuracy:', ML + 6, y, bold, 10, dark)
        y -= 16
        drawText(`Quoted: ${r.quotedOutput} ${r.toSymbol}  |  Received: ${r.receivedOutput} ${r.toSymbol}  |  Difference: ${diff > 0 ? '+' : ''}${diff.toFixed(8)} (${pctDiff}%)`, ML + 10, y, font, 9, diffColor)
        y -= 14
      }
    }
  }

  // Final page number
  page.drawText(`Page ${pageNum}`, {
    x: pageW / 2 - 20, y: 25, font, size: 9,
    color: rgb(0.5, 0.5, 0.5),
  })

  const bytes = await doc.save()
  return Buffer.from(bytes)
}
