/** KEEPKEY-207: a chain whose history provider answers stale or degraded keeps what arrived, without moving stored
 *  rows backwards, and the scan reports it as partial (never as a fresh scan, never as a failure that drops it). */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAINS } from '../src/shared/chains'

const dir = mkdtempSync(join(tmpdir(), 'vault-partial-history-'))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData: dir } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData: dir } }))
let answer: any = null
mock.module('../src/bun/engine-controller', () => ({ withTimeout: async (promise: Promise<any>) => promise }))
mock.module('../src/bun/pioneer', () => ({ getPioneer: async () => ({ GetTransactionHistory: async () => answer }) }))
const db = await import('../src/bun/db')
const { rebuildActivityHistory, clearHistoryQueryCache, partialHistoryMessage } = await import('../src/bun/activity-history')

beforeAll(() => db.initDb())
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

const ltc = CHAINS.find(chain => chain.id === 'litecoin')!
const scope = { deviceId: 'dev', walletId: 'dev:0xa1' }
const stored = (txid: string) => {
  const row = db.getDb()!.query(`SELECT response_body FROM api_log WHERE txid = ? AND wallet_id = ? AND method = 'SCAN'`).get(txid, scope.walletId) as any
  return row ? JSON.parse(row.response_body) : null
}
const scan = () => {
  clearHistoryQueryCache()
  return rebuildActivityHistory({
    wallet: null, scope, chains: [ltc], firmwareVersion: '7.16.0',
    cachedQueries: { litecoin: [{ caip: ltc.caip, pubkey: 'xpub-fixture', label: 'fixture' }] },
    options: { chainId: 'litecoin', collectRows: true },
  })
}
const tx = (txid: string, confirmations: number, blockHeight: number) => ({ txid, confirmations, blockHeight, direction: 'incoming', value: '0.1', timestamp: 1_700_000_000 })

test('partial history is kept: new rows inserted, the chain marked partial, not failed', async () => {
  answer = { data: { histories: [{ transactions: [tx('known', 6, 100)] }] } }
  await scan() // a fresh scan stored it with 6 confirmations
  db.getDb()!.run(`UPDATE api_log SET response_body = json_set(response_body, '$.status', 'confirmed') WHERE txid = 'known'`)

  answer = { data: { histories: [{ transactions: [{ ...tx('known', 2, 0), value: '9', direction: 'outgoing' }, tx('new', 1, 101)], isStale: true }] } }
  const result = await scan()
  const chain = result.chains[0]
  expect(chain.partial).toBe(true)
  expect(chain.error).toBeUndefined()
  expect(result.totals).toMatchObject({ failedChains: 0, partialChains: 1, inserted: 1, updated: 1 })
  expect(stored('new')).toMatchObject({ confirmations: 1, blockHeight: 101 })
  // The stale answer did not move the known row backwards or drop what only it had.
  expect(stored('known')).toMatchObject({ confirmations: 6, blockHeight: 100, status: 'confirmed', value: '0.1', direction: 'received' })
  const kind = db.getDb()!.query(`SELECT activity_type FROM api_log WHERE txid = 'known' AND wallet_id = ?`).get(scope.walletId) as any
  expect(kind.activity_type).toBe('receive') // still matches meta.direction
})

test('a fresh scan can still correct a row (e.g. after a reorg)', async () => {
  answer = { data: { histories: [{ transactions: [tx('known', 3, 102)] }] } }
  const result = await scan()
  expect(result.chains[0].partial).toBeUndefined()
  expect(stored('known')).toMatchObject({ confirmations: 3, blockHeight: 102 })
})

test('malformed history is still a failure, and partial errors are distinct in the log', async () => {
  answer = { data: { histories: [{}] } }
  const result = await scan()
  expect(result.chains[0].error).toContain('incomplete or stale')
  expect(result.chains[0].partial).toBeUndefined()
  expect(partialHistoryMessage('litecoin')).toStartWith('History is partial for litecoin')
})

test('mergePartialTxMeta: the stored row wins; partial only fills gaps and raises confirmations / block height', () => {
  const row = { confirmations: 6, blockHeight: 100, status: 'confirmed', value: '0.1', to: 'ltc1me', from: 'ltc1them', fee: '0.001',
    direction: 'received', walletPaidFee: false, nativeReceiveVerified: true }
  // An older version of the same txid from a degraded provider: different value, addresses, direction, proofs.
  const older = { confirmations: 2, blockHeight: 0, value: '9', to: 'ltc1other', from: 'ltc1me', fee: '0.5',
    direction: 'sent', walletPaidFee: true, nativeReceiveVerified: false, memo: 'only here' }
  expect(db.mergePartialTxMeta(row, older)).toEqual({ ...row, memo: 'only here' })
  // Confirmations / block height may only go up.
  expect(db.mergePartialTxMeta({ confirmations: 1, blockHeight: 0 }, { confirmations: 4, blockHeight: 9 })).toEqual({ confirmations: 4, blockHeight: 9 })
  // A field the stored row lacks is filled.
  expect(db.mergePartialTxMeta({ confirmations: 1 }, { confirmations: 0, value: '2' })).toEqual({ confirmations: 1, value: '2' })
  expect(db.mergePartialTxMeta(null, { confirmations: 1 })).toEqual({ confirmations: 1 })
})
