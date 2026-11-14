import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SwapHistoryRecord } from '../src/shared/types'
import { isSwapFullySettled } from '../src/shared/swap-settlement'

const dir = mkdtempSync(join(tmpdir(), 'vault-swap-payouts-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('../src/bun/db')
beforeAll(() => db.initDb())
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

// RUNE -> Base ETH (audit v4 H11): THORNode settled it with one payout of 0.0002988.
const record: SwapHistoryRecord = { id: 'thor-swap', walletId: 'fixture-wallet', txid: '947E343C',
  fromAsset: 'THOR.RUNE', toAsset: 'BASE.ETH', fromSymbol: 'RUNE', toSymbol: 'ETH', fromChainId: 'thorchain', toChainId: 'base',
  fromAmount: '1', quotedOutput: '0.0003', minimumOutput: '0.00028983', slippageBps: 300, feeBps: 0, feeOutbound: '0',
  integration: 'thorchain', memo: '=:BASE.ETH:0xdest:28983', inboundAddress: '', status: 'pending', createdAt: 1, updatedAt: 1, estimatedTimeSeconds: 60 }
const payouts = [{ txid: '7EFAF203', amount: '0.0002988', asset: 'BASE.ETH', address: '0xdest' }]

test('a completed THOR swap stays complete after a restart (payouts persisted)', () => {
  db.insertSwapHistory(record)
  db.updateSwapHistoryStatus(record.txid, 'completed', { walletId: record.walletId, outboundTxid: '7EFAF203', receivedOutput: '0.0002988', payouts })
  db.closeDb(); db.initDb()
  const stored = db.getSwapHistoryByTxid(record.txid, undefined, record.walletId)!
  expect(stored.payouts).toEqual(payouts)
  expect(isSwapFullySettled({ ...stored, payouts: stored.payouts })).toBe(true)
})

test('a status update without payouts keeps the stored ones', () => {
  db.updateSwapHistoryStatus(record.txid, 'completed', { walletId: record.walletId })
  expect(db.getSwapHistoryByTxid(record.txid, undefined, record.walletId)!.payouts).toEqual(payouts)
})

test('rows written before the column existed read back without payouts', () => {
  db.insertSwapHistory({ ...record, id: 'legacy', txid: 'LEGACY' })
  expect(db.getSwapHistoryByTxid('LEGACY', undefined, record.walletId)!.payouts).toBeUndefined()
})
