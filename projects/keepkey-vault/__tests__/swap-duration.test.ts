/**
 * Swap history duration (actual_time_secs).
 *
 * The settlement paths in swap-tracker.ts (NEAR settlement, Midgard outcome,
 * THORNode settle) finish a swap with completedAt but no actualTimeSeconds, so
 * completed swaps showed an empty Duration in the history dialog and the CSV.
 * Now a completed or refunded swap stores its duration even when the caller
 * gives none, and rows already stored without one read back with the same
 * value derived from their own timestamps. A 'failed' swap gets none unless the
 * caller gives one: the stale-pending cleanup fails swaps after 24 h, and that
 * is not a duration.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SwapHistoryRecord } from '../src/shared/types'

const dir = mkdtempSync(join(tmpdir(), 'vault-swap-duration-'))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData: dir } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData: dir } }))
const db = await import('../src/bun/db')
const { generateSwapCsv } = await import('../src/bun/swap-report')
beforeAll(() => db.initDb())
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

const WALLET = 'duration-wallet'
const START = 1_700_000_000_000
const record = (txid: string): SwapHistoryRecord => ({ id: txid, walletId: WALLET, txid,
  fromAsset: 'BTC.BTC', toAsset: 'ETH.ETH', fromSymbol: 'BTC', toSymbol: 'ETH', fromChainId: 'bitcoin', toChainId: 'ethereum',
  fromAmount: '0.01', quotedOutput: '0.3', minimumOutput: '0.29', slippageBps: 100, feeBps: 0, feeOutbound: '0',
  integration: 'thorchain', memo: '=:ETH.ETH:0xdest', inboundAddress: 'bc1qvault', status: 'pending',
  createdAt: START, updatedAt: START, estimatedTimeSeconds: 600 })
const read = (txid: string) => db.getSwapHistoryByTxid(txid, undefined, WALLET)!

describe('a swap finished without a duration from the caller', () => {
  test('completed: the duration is stored from the row\'s own start (settlement paths)', () => {
    db.insertSwapHistory(record('SETTLED'))
    db.updateSwapHistoryStatus('SETTLED', 'completed', { walletId: WALLET, completedAt: START + 754_400, receivedOutput: '0.3' })
    expect(read('SETTLED').actualTimeSeconds).toBe(754)
  })

  test('refunded: same', () => {
    db.insertSwapHistory(record('REFUNDED'))
    db.updateSwapHistoryStatus('REFUNDED', 'refunded', { walletId: WALLET, completedAt: START + 90_000 })
    expect(read('REFUNDED').actualTimeSeconds).toBe(90)
  })

  test('a later final update does not overwrite the stored duration', () => {
    db.insertSwapHistory(record('TWICE'))
    db.updateSwapHistoryStatus('TWICE', 'completed', { walletId: WALLET, completedAt: START + 40_000 })
    db.updateSwapHistoryStatus('TWICE', 'completed', { walletId: WALLET, completedAt: START + 5_000_000 })
    expect(read('TWICE').actualTimeSeconds).toBe(40)
  })

  test('a completion time before the start stores 0, never a negative duration', () => {
    db.insertSwapHistory(record('CLOCK'))
    db.updateSwapHistoryStatus('CLOCK', 'completed', { walletId: WALLET, completedAt: START - 10_000 })
    expect(read('CLOCK').actualTimeSeconds).toBe(0)
  })

  test('failed (e.g. the 24 h stale-pending cleanup): no duration', () => {
    db.insertSwapHistory(record('TIMEDOUT'))
    db.updateSwapHistoryStatus('TIMEDOUT', 'failed', { walletId: WALLET, error: 'Timed out — check explorer' })
    expect(read('TIMEDOUT').actualTimeSeconds).toBeUndefined()
  })

  test('a pending update stores none', () => {
    db.insertSwapHistory(record('PENDING'))
    db.updateSwapHistoryStatus('PENDING', 'confirming', { walletId: WALLET })
    expect(read('PENDING').actualTimeSeconds).toBeUndefined()
  })
})

describe('a duration given by the caller', () => {
  test('is stored as given (the polling and Relay paths)', () => {
    db.insertSwapHistory(record('POLLED'))
    db.updateSwapHistoryStatus('POLLED', 'completed', { walletId: WALLET, completedAt: START + 60_000, actualTimeSeconds: 61 })
    expect(read('POLLED').actualTimeSeconds).toBe(61)
  })

  test('a failed swap with a duration keeps it', () => {
    db.insertSwapHistory(record('FAILED'))
    db.updateSwapHistoryStatus('FAILED', 'failed', { walletId: WALLET, completedAt: START + 30_000, actualTimeSeconds: 30 })
    expect(read('FAILED').actualTimeSeconds).toBe(30)
  })

  test('0 seconds reads back as 0, not as missing', () => {
    db.insertSwapHistory(record('INSTANT'))
    db.updateSwapHistoryStatus('INSTANT', 'completed', { walletId: WALLET, completedAt: START, actualTimeSeconds: 0 })
    expect(read('INSTANT').actualTimeSeconds).toBe(0)
  })
})

describe('rows already stored without a duration', () => {
  test('a completed row reads back with the duration from its timestamps (and keeps it when refreshed later); a failed one without', () => {
    db.insertSwapHistory(record('LEGACY-DONE'))
    db.insertSwapHistory(record('LEGACY-FAIL'))
    // As the old settlement paths left them: final status and completed_at, no actual_time_secs.
    db.closeDb()
    const raw = new Database(join(dir, 'vault.db'))
    try {
      raw.run(`UPDATE swap_history SET status = 'completed', completed_at = ?, actual_time_secs = NULL WHERE txid = 'LEGACY-DONE'`, [START + 125_000])
      raw.run(`UPDATE swap_history SET status = 'failed', completed_at = ?, actual_time_secs = NULL WHERE txid = 'LEGACY-FAIL'`, [START + 86_400_000])
    } finally { raw.close() }
    db.initDb()
    expect(read('LEGACY-DONE').actualTimeSeconds).toBe(125)
    expect(read('LEGACY-FAIL').actualTimeSeconds).toBeUndefined()
    // Refreshed days later, the old row stores the duration to its original completion, not to the refresh.
    db.updateSwapHistoryStatus('LEGACY-DONE', 'completed', { walletId: WALLET, completedAt: START + 3 * 86_400_000 })
    expect(read('LEGACY-DONE').actualTimeSeconds).toBe(125)
  })
})

test('the CSV Duration column is filled for a settled swap', () => {
  db.insertSwapHistory(record('CSV'))
  db.updateSwapHistoryStatus('CSV', 'completed', { walletId: WALLET, completedAt: START + 754_400 })
  const csv = generateSwapCsv([read('CSV')])
  const [header, row] = csv.trim().split(/\r?\n/)
  const col = header.split(',').indexOf('Duration (s)')
  expect(col).toBeGreaterThan(-1)
  expect(row.split(',')[col].replace(/"/g, '')).toBe('754')
})
