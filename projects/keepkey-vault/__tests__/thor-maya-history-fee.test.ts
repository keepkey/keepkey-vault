import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAINS } from '../src/shared/chains'

// Audit v4 H10: THOR/Maya history rows carry the tx's auth fee ('0'), while the
// network charges 0.02 RUNE / 0.2 CACAO at the bank layer. Scan rows are base units.
const dir = mkdtempSync(join(tmpdir(), 'vault-history-fee-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
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
