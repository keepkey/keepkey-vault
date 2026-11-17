import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChainBalance } from '../src/shared/types'

// Audit v4 H3: a cached balance older than the chain's last broadcast or swap
// settlement must never read as synced, also after a relaunch.
const dir = mkdtempSync(join(tmpdir(), 'vault-balance-tx-mark-'))
mock.module('electrobun/main/utils', () => ({ paths: { userData: dir } }))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const Utils = await import('electrobun/main/utils')
// Fail before importing or initializing the DB if an SDK import changed. A
// legacy electrobun/bun mock alone does not isolate the current database path.
if (join(Utils.paths.userData, 'vault.db') !== join(dir, 'vault.db')) throw new Error('Balance cache tests must use only their disposable database')
const db = await import('../src/bun/db')
beforeAll(() => {
  expect(Utils.paths.userData).toBe(dir)
  db.initDb()
})
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

const device = 'fixture-device'
const base: ChainBalance = { chainId: 'base', symbol: 'ETH', balance: '0.001134', balanceUsd: 3.4, address: '0xowner' }
const thor: ChainBalance = { chainId: 'thorchain', symbol: 'RUNE', balance: '12', balanceUsd: 20, address: 'thor1owner' }
const row = (chainId: string) => db.getCachedBalances(device)!.balances.find(b => b.chainId === chainId)!

test('a cached chain with a broadcast after it is stale, the others are not, and it survives a relaunch', () => {
  db.setCachedBalances(device, [base, thor], new Set(['base', 'thorchain']))
  expect(row('base').syncState).toBeUndefined()
  db.markBalanceTx(device, 'base')
  db.closeDb(); db.initDb()
  expect(row('base').syncState).toBe('stale')
  expect(row('thorchain').syncState).toBeUndefined()
})

test('an unconfirmed (stale provider) write keeps the mark; a confirmed one clears it', () => {
  db.updateCachedBalance(device, { ...base, balance: '0.001134', balanceUsd: 3.5 }, false)
  expect(row('base').syncState).toBe('stale')
  db.setCachedBalances(device, [{ ...base, balanceUsd: 3.6 }])
  expect(row('base').syncState).toBe('stale')
  // (read started once the tx had time to land — see TX_SETTLE_MS)
  db.updateCachedBalance(device, { ...base, balance: '0.001433', balanceUsd: 4.3 }, true, Date.now() + db.TX_SETTLE_MS)
  expect(row('base').syncState).toBeUndefined()
  expect(row('base').balance).toBe('0.001433')
  db.markBalanceTx(device, 'thorchain')
  db.setCachedBalances(device, [thor], new Set(['thorchain']), Date.now() + db.TX_SETTLE_MS)
  expect(row('thorchain').syncState).toBeUndefined()
})

test('a confirmed read that started before the tx could land keeps the mark (THOR: next block)', () => {
  const tx = Date.now()
  db.markBalanceTx(device, 'thorchain', tx)
  // The 0 s post-tx read: Pioneer answers with the pre-tx balance as "confirmed".
  expect(db.updateCachedBalance(device, { ...thor, balance: '12' }, true, tx + 100)).toBe(true)
  expect(row('thorchain').syncState).toBe('stale')
  db.setCachedBalances(device, [{ ...thor, balance: '12' }], new Set(['thorchain']), tx + 4_000)
  expect(row('thorchain').syncState).toBe('stale')
  // A read started once the tx had time to land clears it.
  expect(db.updateCachedBalance(device, { ...thor, balance: '11.98' }, true, tx + db.TX_SETTLE_MS)).toBe(false)
  expect(row('thorchain').syncState).toBeUndefined()
  db.markBalanceTx(device, 'thorchain', tx)
  db.setCachedBalances(device, [{ ...thor, balance: '11.98' }], new Set(['thorchain']), tx + db.TX_SETTLE_MS)
  expect(row('thorchain').syncState).toBeUndefined()
})

test('unconfirmed updates preserve the last confirmed age and a pending transaction mark', () => {
  const deviceId = 'age-unconfirmed', sourceAt = Date.now() - 120_000, readAt = sourceAt + 1_000
  db.setCachedBalances(deviceId, [{ ...base, updatedAt: sourceAt }], new Set(['base']), readAt)
  db.markBalanceTx(deviceId, 'base', readAt + 1_000)
  const cached = () => db.getCachedBalances(deviceId)!.balances[0]
  db.updateCachedBalance(deviceId, { ...base, balanceUsd: 4, updatedAt: Date.now() }, false)
  expect(cached().updatedAt).toBe(sourceAt)
  expect(cached().syncState).toBe('stale')
  db.setCachedBalances(deviceId, [{ ...base, balanceUsd: 5, updatedAt: Date.now() }])
  expect(cached().updatedAt).toBe(sourceAt)
  expect(cached().syncState).toBe('stale')
})

test('new unconfirmed rows remain unverified even when the provider supplies an age', () => {
  const sourceAt = Date.now() - 86_400_000
  db.setCachedBalances('age-new-bulk', [base, { ...thor, updatedAt: sourceAt }])
  const bulk = db.getCachedBalances('age-new-bulk')!
  expect(bulk.balances.find(b => b.chainId === 'base')!.updatedAt).toBe(0)
  expect(bulk.balances.find(b => b.chainId === 'thorchain')!.updatedAt).toBe(0)
  expect(bulk.balances.every(b => b.syncState === 'degraded')).toBe(true)
  expect(bulk.updatedAt).toBe(0)
  db.updateCachedBalance('age-new-single', base, false)
  expect(db.getCachedBalances('age-new-single')!.balances[0].updatedAt).toBe(0)
})

test('unconfirmed positive amounts and token/position changes cannot replace a confirmed snapshot', () => {
  const deviceId = 'cache-positive-unconfirmed', sourceAt = Date.now() - 120_000
  const confirmed: ChainBalance = { ...base, balanceUsd: 30, updatedAt: sourceAt,
    tokens: [{ symbol: 'USDC', name: 'USD Coin', balance: '10', balanceUsd: 10, priceUsd: 1,
      caip: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }],
    defiPositions: [{ protocol: 'fixture', network: 'base', balanceUsd: 5 }],
  }
  db.setCachedBalances(deviceId, [confirmed], new Set(['base']), sourceAt)
  db.markBalanceTx(deviceId, 'base', sourceAt + 1_000)
  const before = db.getCachedBalances(deviceId)!.balances[0]
  const unconfirmed: ChainBalance = { ...base, symbol: 'OTHER', balance: '99', balanceUsd: 999,
    address: '0x-unverified-owner', updatedAt: Date.now(),
    tokens: [{ ...confirmed.tokens![0], balance: '999', balanceUsd: 999 }], defiPositions: [],
  }
  db.updateCachedBalance(deviceId, unconfirmed, false)
  expect(db.getCachedBalances(deviceId)!.balances[0]).toEqual(before)
  db.setCachedBalances(deviceId, [unconfirmed])
  expect(db.getCachedBalances(deviceId)!.balances[0]).toEqual(before)
})

test('confirmed writes preserve source age and otherwise use read start rather than response receipt', () => {
  const sourceAt = Date.now() - 60_000, readAt = sourceAt + 10_000
  db.setCachedBalances('age-confirmed-bulk', [{ ...base, updatedAt: sourceAt }, thor], new Set(['base', 'thorchain']), readAt)
  const bulk = db.getCachedBalances('age-confirmed-bulk')!
  expect(bulk.balances.find(b => b.chainId === 'base')!.updatedAt).toBe(sourceAt)
  expect(bulk.balances.find(b => b.chainId === 'thorchain')!.updatedAt).toBe(readAt)
  expect(bulk.updatedAt).toBe(sourceAt)
  db.updateCachedBalance('age-confirmed-single', { ...base, updatedAt: sourceAt }, true, readAt)
  expect(db.getCachedBalances('age-confirmed-single')!.balances[0].updatedAt).toBe(sourceAt)
  for (const updatedAt of [undefined, -1, NaN, Infinity]) {
    db.updateCachedBalance('age-confirmed-single', { ...base, updatedAt }, true, readAt)
    expect(db.getCachedBalances('age-confirmed-single')!.balances[0].updatedAt).toBe(readAt)
  }
})

test('an explicit unknown source age cannot replace a known snapshot or clear its tx mark', () => {
  const deviceId = 'tx-unknown-source', txAt = Date.now() - 60_000
  const readAt = txAt + db.TX_SETTLE_MS + 1_000
  db.setCachedBalances(deviceId, [{ ...base, updatedAt: txAt - 1_000 }], new Set(['base']), txAt - 1_000)
  db.markBalanceTx(deviceId, 'base', txAt)
  expect(db.updateCachedBalance(deviceId, { ...base, updatedAt: 0 }, true, readAt)).toBe(true)
  expect(db.getCachedBalances(deviceId)!.balances[0]).toMatchObject({ updatedAt: txAt - 1_000, syncState: 'stale', txPending: true })
  db.setCachedBalances(deviceId, [{ ...base, updatedAt: 0 }], new Set(['base']), readAt)
  expect(db.getCachedBalances(deviceId)!.balances[0]).toMatchObject({ updatedAt: txAt - 1_000, syncState: 'stale', txPending: true })
  db.updateCachedBalance('age-confirmed-unknown', { ...base, updatedAt: 0 }, true, readAt)
  expect(db.getCachedBalances('age-confirmed-unknown')!.balances[0]).toMatchObject({ updatedAt: 0, syncState: 'degraded' })
})

test('an older confirmed source finishing late cannot replace a newer snapshot or clear its transaction mark', () => {
  const deviceId = 'cache-read-order', readAt = Date.now(), newerAt = readAt - 60_000, olderAt = newerAt - 60_000
  const current = { ...base, balance: '2', balanceUsd: 6, updatedAt: newerAt }
  db.setCachedBalances(deviceId, [current], new Set(['base']), newerAt)
  db.markBalanceTx(deviceId, 'base', newerAt + 1_000)
  const before = db.getCachedBalances(deviceId)!.balances[0]
  const late = { ...base, balance: '0', balanceUsd: 0, updatedAt: olderAt }
  expect(db.updateCachedBalance(deviceId, late, true, readAt)).toBe(true)
  expect(db.getCachedBalances(deviceId)!.balances[0]).toEqual(before)
  db.setCachedBalances(deviceId, [late], new Set(['base']), readAt)
  expect(db.getCachedBalances(deviceId)!.balances[0]).toEqual(before)
  db.setCachedBalances(deviceId, [{ ...late, updatedAt: 0 }], new Set(['base']), readAt)
  expect(db.getCachedBalances(deviceId)!.balances[0]).toEqual(before)
  const observedAt = newerAt + db.TX_SETTLE_MS + 2_000
  expect(db.updateCachedBalance(deviceId, { ...base, updatedAt: observedAt }, true, readAt)).toBe(false)
  expect(db.getCachedBalances(deviceId)!.balances[0].updatedAt).toBe(observedAt)
  expect(db.getCachedBalances(deviceId)!.balances[0].syncState).toBeUndefined()
})

test('cached source data from before a transaction cannot clear its mark on a later read', () => {
  const deviceId = 'tx-old-source', txAt = Date.now() - 60_000, sourceAt = txAt - 1_000
  const afterSettle = txAt + db.TX_SETTLE_MS + 1_000
  db.setCachedBalances(deviceId, [{ ...base, updatedAt: sourceAt }], new Set(['base']), sourceAt)
  db.markBalanceTx(deviceId, 'base', txAt)
  expect(db.updateCachedBalance(deviceId, { ...base, updatedAt: sourceAt }, true, afterSettle)).toBe(true)
  expect(db.getCachedBalances(deviceId)!.balances[0].syncState).toBe('stale')
  db.setCachedBalances(deviceId, [{ ...base, updatedAt: sourceAt }], new Set(['base']), afterSettle)
  expect(db.getCachedBalances(deviceId)!.balances[0].syncState).toBe('stale')
  // A genuine confirmed zero from after settlement still replaces the old
  // positive balance, clears the mark, and retains that source timestamp.
  db.updateCachedBalance(deviceId, { ...base, balance: '0', balanceUsd: 0, updatedAt: afterSettle }, true, afterSettle + 1_000)
  expect(db.getCachedBalances(deviceId)!.balances[0]).toMatchObject({ balance: '0', balanceUsd: 0, updatedAt: afterSettle })
  expect(db.getCachedBalances(deviceId)!.balances[0].syncState).toBeUndefined()
})
