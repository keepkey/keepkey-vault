import { afterAll, describe, expect, test } from 'bun:test'
import { buildRecord, flush, instrumentPortfolio, pushRecord, setPerfTelemetryOffline } from './perf-telemetry'

const originalFetch = globalThis.fetch
let fetches = 0

afterAll(() => {
  setPerfTelemetryOffline(true)
  globalThis.fetch = originalFetch
})

describe('performance telemetry offline policy', () => {
  test('buffered telemetry cannot flush while offline and resumes online', async () => {
    globalThis.fetch = (async () => {
      fetches++
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    setPerfTelemetryOffline(true)
    instrumentPortfolio({ GetPortfolioBalances: async () => ({ data: {} }) }, {
      apiBase: 'https://telemetry.invalid',
      queryKey: 'test-key',
    })
    pushRecord(buildRecord({ clientTotalMs: 1 }))
    await flush()
    expect(fetches).toBe(0)

    setPerfTelemetryOffline(false)
    await flush()
    expect(fetches).toBe(1)
  })
})
