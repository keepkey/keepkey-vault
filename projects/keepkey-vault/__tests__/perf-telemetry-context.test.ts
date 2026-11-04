import { afterAll, beforeEach, expect, test } from 'bun:test'
import { buildRecord, flush, instrumentPortfolio, pushRecord, recentPerfRecords, setPerfTelemetryOffline } from '../src/bun/perf-telemetry'
const originalFetch = globalThis.fetch
let urls: string[] = []
beforeEach(async () => {
  globalThis.fetch = (async (input: string | URL | Request) => { urls.push(String(input)); return new Response('{}', { status: 200 }) }) as typeof fetch
  instrumentPortfolio({}, { apiBase: 'https://current.example', queryKey: 'test' })
  setPerfTelemetryOffline(false); await flush(); urls = []
})
afterAll(() => { setPerfTelemetryOffline(true); globalThis.fetch = originalFetch })

test('queued telemetry cannot contact a server after its context becomes obsolete', async () => {
  let current = true
  instrumentPortfolio({}, { apiBase: 'https://old.example', queryKey: 'old', isCurrent: () => current })
  pushRecord(buildRecord({ clientTotalMs: 1, meta: { traceId: 'old-record' } }))
  current = false
  await flush()
  expect(urls).toEqual([])
  instrumentPortfolio({}, { apiBase: 'https://new.example', queryKey: 'new', isCurrent: () => true })
  pushRecord(buildRecord({ clientTotalMs: 2, meta: { traceId: 'new-record' } }))
  expect(recentPerfRecords(50).map(record => record.traceId)).toEqual(['new-record'])
  await flush()
  expect(urls).toEqual(['https://new.example/api/v1/telemetry/vault'])
})

test('a portfolio result completing after a switch does not enter the new telemetry context', async () => {
  let current = true, finish!: (value: any) => void
  const client = { GetPortfolioBalances: () => new Promise<any>(resolve => { finish = resolve }) }
  instrumentPortfolio(client, { apiBase: 'https://old.example', queryKey: 'old', isCurrent: () => current })
  const pending = client.GetPortfolioBalances()
  current = false
  instrumentPortfolio({}, { apiBase: 'https://new.example', queryKey: 'new' })
  finish({ data: { meta: { traceId: 'obsolete-result' } } }); await pending
  expect(recentPerfRecords(50)).toEqual([])
  await flush(); expect(urls).toEqual([])
})
