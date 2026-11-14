import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Audit v4 H15: a REST "sign" row whose tx never went out stayed "Signed" forever.
const dir = mkdtempSync(join(tmpdir(), 'vault-activity-not-sent-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('../src/bun/db')
beforeAll(() => db.initDb())
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

const wallet = { deviceId: 'fixture-device', walletId: 'fixture-wallet' }
const DAY = 24 * 60 * 60 * 1000
const log = (route: string, ageMs: number, extra: Record<string, unknown> = {}) => db.insertApiLog({
  ...wallet, method: 'POST', route, timestamp: Date.now() - ageMs, durationMs: 1, status: 200, appName: 'fixture-dapp',
  chain: 'ETH', activityType: 'sign', ...extra,
} as any)
const rows = () => db.getRecentActivityFromLog(undefined, undefined, wallet.deviceId, wallet.walletId)
const byApp = (route: string) => rows().find(r => r.appName === route)

test('a signed tx Desktop never saw broadcast reads "not sent" once it is a day old', () => {
  log('/eth/sign-transaction', 11 * DAY, { appName: 'old-sign' })
  log('/eth/sign-transaction', 60 * 60 * 1000, { appName: 'fresh-sign' })
  expect(byApp('old-sign')?.status).toBe('not_sent')
  expect(byApp('fresh-sign')?.status).toBe('signed')
})

test('a signed message is never "not sent": nothing is broadcast for it', () => {
  log('/eth/sign', 11 * DAY, { appName: 'old-message' })
  log('/eth/sign-typed-data', 11 * DAY, { appName: 'old-typed' })
  expect(byApp('old-message')?.status).toBe('signed')
  expect(byApp('old-typed')?.status).toBe('signed')
})

test('a signed tx later seen on chain under its txid is one broadcast row, not a stale signature', () => {
  const txid = '0x' + 'ab'.repeat(32)
  log('/eth/sign-transaction', 11 * DAY, { appName: 'sent-later', txid })
  db.insertApiLog({ ...wallet, method: 'SCAN', route: 'history/ethereum', timestamp: Date.now() - 10 * DAY, durationMs: 0, status: 200,
    appName: 'scan', txid, chain: 'ETH', activityType: 'send', responseBody: { chainId: 'ethereum', chainSymbol: 'ETH', value: '1000' } } as any)
  const matches = rows().filter(r => r.txid === txid)
  expect(matches).toHaveLength(1)
  expect(matches[0].status).toBe('broadcast')
  expect(matches[0].type).toBe('send')
})

test('discarding a not-sent row hides it from activity but keeps the audit record', () => {
  const row = byApp('old-sign')!
  expect(db.dismissActivity(row.id, wallet.deviceId, wallet.walletId)).toBe(true)
  expect(byApp('old-sign')).toBeUndefined()
  expect(db.getApiLogs(500, 0, wallet.deviceId, wallet.walletId).some(e => e.appName === 'old-sign')).toBe(true)
})

test('only unsent signatures can be discarded, and only in their own wallet', () => {
  const sent = rows().find(r => r.status === 'broadcast')!
  expect(db.dismissActivity(sent.id, wallet.deviceId, wallet.walletId)).toBe(false)
  const fresh = byApp('fresh-sign')!
  expect(db.dismissActivity(fresh.id, wallet.deviceId, 'other-wallet')).toBe(false)
  expect(byApp('fresh-sign')).toBeDefined()
})
