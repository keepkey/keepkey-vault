/**
 * perf-telemetry pure-logic tests — outcome classification, record building,
 * ring-buffer cap, and the GetPortfolioBalances wrapper's meta extraction.
 * Imports ONLY src/bun/perf-telemetry (pure; no db/device), safe under bun test.
 *
 * Run: bun test __tests__/perf-telemetry.test.ts
 */
import { describe, test, expect } from 'bun:test'
import {
  classifyOutcome, buildRecord, pushRecord, recentPerfRecords, instrumentPortfolio,
  SLOW_THRESHOLD_MS, TIMEOUT_THRESHOLD_MS,
} from '../src/bun/perf-telemetry'

describe('classifyOutcome', () => {
  test('ok under the slow threshold', () => {
    expect(classifyOutcome({ errored: false, clientTotalMs: 800, degraded: false })).toBe('ok')
  })
  test('slow over 3s', () => {
    expect(classifyOutcome({ errored: false, clientTotalMs: SLOW_THRESHOLD_MS + 1, degraded: false })).toBe('slow')
  })
  test('degraded wins over slow', () => {
    expect(classifyOutcome({ errored: false, clientTotalMs: 5000, degraded: true })).toBe('degraded')
  })
  test('error on throw', () => {
    expect(classifyOutcome({ errored: true, clientTotalMs: 500, degraded: false, errorMessage: 'boom' })).toBe('error')
  })
  test('timeout on timeout-ish message', () => {
    expect(classifyOutcome({ errored: true, clientTotalMs: 500, degraded: false, errorMessage: 'GetPortfolioBalances chunk timed out' })).toBe('timeout')
  })
  test('timeout on long-elapsed error', () => {
    expect(classifyOutcome({ errored: true, clientTotalMs: TIMEOUT_THRESHOLD_MS, degraded: false, errorMessage: 'socket hang up' })).toBe('timeout')
  })
})

describe('buildRecord', () => {
  test('echoes traceId/serverMs/degraded from meta', () => {
    const rec = buildRecord({ clientTotalMs: 1234.7, meta: { traceId: 'abc', serverMs: 912, degraded: false } })
    expect(rec.traceId).toBe('abc')
    expect(rec.serverMs).toBe(912)
    expect(rec.clientTotalMs).toBe(1235)
    expect(rec.outcome).toBe('ok')
    expect(rec.appVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(rec.platform).toMatch(/^desktop-/)
  })
  test('failed request has no traceId/serverMs and outcome error', () => {
    const rec = buildRecord({ clientTotalMs: 400, errored: true, errorMessage: 'ECONNREFUSED' })
    expect(rec.traceId).toBeUndefined()
    expect(rec.serverMs).toBeUndefined()
    expect(rec.outcome).toBe('error')
  })
})

describe('ring buffer', () => {
  test('caps at 50 drop-oldest', () => {
    for (let i = 0; i < 60; i++) {
      pushRecord(buildRecord({ clientTotalMs: i, meta: { traceId: `t${i}` } }))
    }
    const recent = recentPerfRecords(50)
    expect(recent.length).toBeLessThanOrEqual(50)
    expect(recent[recent.length - 1].traceId).toBe('t59')
  })
})

describe('instrumentPortfolio', () => {
  test('wraps once and records from resp.data.meta', async () => {
    const calls: any[] = []
    const client: any = {
      GetPortfolioBalances: async (body: any) => {
        calls.push(body)
        return { data: { balances: [], meta: { traceId: 'wrapped-1', serverMs: 42, degraded: true } } }
      },
    }
    instrumentPortfolio(client, { apiBase: 'http://localhost:9', queryKey: 'test' })
    instrumentPortfolio(client, { apiBase: 'http://localhost:9', queryKey: 'test' }) // no double-wrap
    const resp = await client.GetPortfolioBalances({ pubkeys: [] })
    expect(calls.length).toBe(1)
    expect(resp.data.meta.traceId).toBe('wrapped-1')
    const last = recentPerfRecords(1)[0]
    expect(last.traceId).toBe('wrapped-1')
    expect(last.serverMs).toBe(42)
    expect(last.outcome).toBe('degraded')
  })
  test('rethrows errors and still records', async () => {
    const client: any = {
      GetPortfolioBalances: async () => { throw new Error('ECONNRESET') },
    }
    instrumentPortfolio(client, { apiBase: 'http://localhost:9', queryKey: 'test' })
    await expect(client.GetPortfolioBalances({})).rejects.toThrow('ECONNRESET')
    expect(recentPerfRecords(1)[0].outcome).toBe('error')
  })
})
