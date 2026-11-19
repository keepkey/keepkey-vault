import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAINS } from '../src/shared/chains'

// Audit v4 H10: THOR/Maya history rows carry the tx's auth fee ('0'), while the
// network charges 0.02 RUNE / 0.2 CACAO at the bank layer. Scan rows are base units.
const dir = mkdtempSync(join(tmpdir(), 'vault-history-fee-'))
mock.module('electrobun/main/utils', () => ({ paths: { userData: dir } }))
// No device or network in this suite.
mock.module('../src/bun/engine-controller', () => ({ withTimeout: async (promise: Promise<any>) => promise }))
mock.module('../src/bun/pioneer', () => ({ getPioneer: async () => { throw new Error('No network in this suite') } }))
const { normalizeMeta } = await import('../src/bun/activity-history')
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const chain = (id: string) => CHAINS.find(c => c.id === id)!

test('a THORChain send from history shows the 0.02 RUNE native fee, not 0', () => {
  expect(normalizeMeta({ direction: 'sent', value: '100000000', fee: '0' }, 'send', chain('thorchain')).fee).toBe('2000000')
  expect(normalizeMeta({ direction: 'sent', value: '100000000' }, 'send', chain('thorchain')).fee).toBe('2000000')
})

test('a MAYAChain send from history shows the 0.2 CACAO native fee, not 0', () => {
  expect(normalizeMeta({ direction: 'sent', value: '10000000000', fee: '0' }, 'send', chain('mayachain')).fee).toBe('2000000000')
})

test('receives pay no fee, other chains and real fees are untouched', () => {
  expect(normalizeMeta({ direction: 'received', value: '1', fee: '0' }, 'receive', chain('thorchain')).fee).toBe('0')
  expect(normalizeMeta({ direction: 'sent', value: '1', fee: '5000' }, 'send', chain('cosmos')).fee).toBe('5000')
  expect(normalizeMeta({ direction: 'sent', value: '1', fee: '3000000' }, 'send', chain('thorchain')).fee).toBe('3000000')
})

// Audit v6 R6: rows stored before the H10 fix keep fee '0' until a rescan
// rewrites them, so the activity list still read "fee: 0 RUNE". Reading applies
// the native fee too.
test('a stored THORChain send row with fee 0 reads the 0.02 RUNE native fee', async () => {
  const db = await import('../src/bun/db')
  db.initDb()
  try {
    const wallet = { deviceId: 'fixture-device', walletId: 'fixture-wallet' }
    const scan = (txid: string, activityType: string, meta: Record<string, unknown>) => db.insertApiLog({
      ...wallet, method: 'SCAN', route: `history/${meta.chainId}`, timestamp: Date.now(), durationMs: 0, status: 200,
      appName: 'vault', txid, chain: String(meta.chainSymbol), activityType, responseBody: meta,
    } as any)
    scan('THOR-OLD-SEND', 'send', { chainId: 'thorchain', chainSymbol: 'RUNE', value: '10000000', fee: '0' })
    scan('THOR-OLD-RECEIVE', 'receive', { chainId: 'thorchain', chainSymbol: 'RUNE', value: '10000000', fee: '0' })
    scan('ATOM-SEND', 'send', { chainId: 'cosmos', chainSymbol: 'ATOM', value: '1', fee: '5000' })
    const rows = db.getRecentActivityFromLog(undefined, undefined, wallet.deviceId, wallet.walletId)
    const fee = (txid: string) => rows.find(r => r.txid === txid)?.fee
    expect(fee('THOR-OLD-SEND')).toBe('2000000')
    expect(fee('THOR-OLD-RECEIVE')).toBe('0')
    expect(fee('ATOM-SEND')).toBe('5000')
  } finally {
    db.closeDb()
  }
})
