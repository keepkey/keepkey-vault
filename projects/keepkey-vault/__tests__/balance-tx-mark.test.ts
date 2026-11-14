import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChainBalance } from '../src/shared/types'

// Audit v4 H3: a cached balance older than the chain's last broadcast or swap
// settlement must never read as synced, also after a relaunch.
const dir = mkdtempSync(join(tmpdir(), 'vault-balance-tx-mark-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('../src/bun/db')
beforeAll(() => db.initDb())
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
