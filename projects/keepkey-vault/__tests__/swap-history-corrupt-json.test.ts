/** Audit v6 H9: one swap_history row with unreadable JSON must not empty the whole history or stop pending tracking. */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SwapHistoryRecord } from '../src/shared/types'

const dir = mkdtempSync(join(tmpdir(), 'vault-swap-corrupt-'))
// db.ts finds its folder through electrobun/main/utils; mock that one so the test never shares a database with another suite.
mock.module('electrobun/main', () => ({ Utils: { paths: { userData: dir } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData: dir } }))
const db = await import('../src/bun/db')
beforeAll(() => db.initDb())
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

// A wallet of its own, and every check looks only at this file's rows, in case the database is shared anyway.
const walletId = 'corrupt-json-wallet'
const base: SwapHistoryRecord = { id: 'x', walletId, txid: 'x',
  fromAsset: 'THOR.RUNE', toAsset: 'BASE.ETH', fromSymbol: 'RUNE', toSymbol: 'ETH', fromChainId: 'thorchain', toChainId: 'base',
  fromAmount: '1', quotedOutput: '0.0003', minimumOutput: '0.00028983', slippageBps: 300, feeBps: 0, feeOutbound: '0',
  integration: 'thorchain', memo: '=:BASE.ETH:0xdest:28983', inboundAddress: '', status: 'pending', createdAt: 1, updatedAt: 1, estimatedTimeSeconds: 60 }
const context = { fromAddress: 'thor1from', toAddress: '0xdest' }
const payouts = [{ txid: '7EFAF203', amount: '0.0002988', asset: 'BASE.ETH', address: '0xdest' }]

function insert(txid: string, columns: { payouts_json?: string; tracking_context?: string } = {}, createdAt = 1) {
  db.insertSwapHistory({ ...base, id: txid, txid, createdAt, trackingContext: context })
  db.updateSwapHistoryStatus(txid, 'pending', { walletId, payouts })
  for (const [column, value] of Object.entries(columns)) db.getDb()!.run(`UPDATE swap_history SET ${column} = ? WHERE txid = ?`, [value, txid])
}

test('a corrupt row keeps the rest of the history and the pending list the tracker resumes from', () => {
  insert('GOOD', {}, 3)
  insert('BAD-PAYOUTS', { payouts_json: '[{"txid":' }, 2)
  insert('BAD-CONTEXT', { tracking_context: '{not json' }, 1)

  // Before the fix, both reads returned [] because one JSON.parse threw inside rows.map.
  const all = db.getSwapHistory({ walletId })
  expect(all.map(r => r.txid)).toEqual(['GOOD', 'BAD-PAYOUTS', 'BAD-CONTEXT'])
  const mine = new Set(['GOOD', 'BAD-PAYOUTS', 'BAD-CONTEXT'])
  expect(db.getSwapHistory({ status: 'pending', limit: 100 }).filter(r => mine.has(r.txid)).length).toBe(3)

  const byTxid = (txid: string) => all.find(r => r.txid === txid)!
  expect(byTxid('GOOD').payouts).toEqual(payouts)
  expect(byTxid('GOOD').trackingContext).toEqual(context)
  // Only the unreadable column is dropped; the row's other fields survive.
  expect(byTxid('BAD-PAYOUTS').payouts).toBeUndefined()
  expect(byTxid('BAD-PAYOUTS').trackingContext).toEqual(context)
  expect(byTxid('BAD-CONTEXT').trackingContext).toBeUndefined()
  expect(byTxid('BAD-CONTEXT').payouts).toEqual(payouts)
  expect(db.getSwapHistoryByTxid('BAD-PAYOUTS', undefined, walletId)!.memo).toBe(base.memo)
})

test('valid JSON with the wrong shape is treated as absent, so the UI never maps over a non-list', () => {
  insert('OBJECT-PAYOUTS', { payouts_json: '{"txid":"a"}' })
  insert('MIXED-PAYOUTS', { payouts_json: JSON.stringify([...payouts, null, { txid: 'b' }, { txid: 'c', amount: 5, asset: 'X' }]) })
  insert('ARRAY-CONTEXT', { tracking_context: '[]' })
  insert('NO-ADDRESS-CONTEXT', { tracking_context: '{"fromAddress":"thor1from"}' })

  const read = (txid: string) => db.getSwapHistoryByTxid(txid, undefined, walletId)!
  expect(read('OBJECT-PAYOUTS').payouts).toBeUndefined()
  expect(read('MIXED-PAYOUTS').payouts).toEqual(payouts)
  expect(read('ARRAY-CONTEXT').trackingContext).toBeUndefined()
  expect(read('NO-ADDRESS-CONTEXT').trackingContext).toBeUndefined()
})

test('optional tracking fields of the wrong type are dropped, the valid ones kept', () => {
  const nearIntents = { depositAddress: '0xdeposit' }
  insert('TYPED-CONTEXT', { tracking_context: JSON.stringify({ ...context, relaySolverDeposit: 'false', fromAmountBaseUnits: 5, nearIntents }) })
  insert('FULL-CONTEXT', { tracking_context: JSON.stringify({ ...context, relaySolverDeposit: true, fromAmountBaseUnits: '5', nearIntents }) })
  const read = (txid: string) => db.getSwapHistoryByTxid(txid, undefined, walletId)!.trackingContext
  expect(read('TYPED-CONTEXT')).toEqual({ ...context, nearIntents })
  expect(read('FULL-CONTEXT')).toEqual({ ...context, relaySolverDeposit: true, fromAmountBaseUnits: '5', nearIntents })
})

test('a bad column is reported once, not on every poll, and without the full txid', () => {
  const warn = console.warn
  const lines: string[] = []
  console.warn = (...args: unknown[]) => { lines.push(args.join(' ')) }
  try {
    insert('REPORTED-ONCE-0123456789', { payouts_json: 'nope' })
    for (let i = 0; i < 3; i++) db.getSwapHistory({ walletId })
  } finally { console.warn = warn }
  const mine = lines.filter(line => line.includes('REPORTED-O'))
  expect(mine).toEqual(['[db] swap_history REPORTED-O: unreadable payouts_json, ignored'])
})
