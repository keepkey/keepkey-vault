import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { fetchSwapHealth } from '../src/bun/swap-health'
import { swapHealthSummary, swapProviderPresentation, swapHealthQuoteExplanation } from '../src/shared/swap-health'
import type { SwapHealth, SwapIntegrationHealth } from '../src/shared/types'

const onDemand: SwapIntegrationHealth = {
  key: 'thorchain', label: 'THORChain', status: 'unknown',
  detail: 'Checked on quote demand; no background polling',
}
const gated: SwapIntegrationHealth = {
  key: 'swapkit', label: 'SwapKit', status: 'gated',
  detail: 'API-key fallback remains unavailable unless each quote proves nonzero affiliate attribution',
}
const health: SwapHealth = { fetchedAt: 1793556312435, integrations: [onDemand, gated] }
let fetchMock: ReturnType<typeof spyOn> | undefined
afterEach(() => { fetchMock?.mockRestore(); fetchMock = undefined })

describe('swap provider status', () => {
  test('explains on-demand checks instead of implying an outage', () => {
    expect(swapProviderPresentation(onDemand)).toMatchObject({ label: 'On demand', description: onDemand.detail })
    expect(swapHealthSummary(health).label).toBe('Provider availability is checked when requesting a quote')
  })

  test('distinguishes gated routes from unknown and offline', () => {
    expect(swapProviderPresentation(gated)).toMatchObject({ label: 'Restricted', description: gated.detail })
  })

  test('keeps unknown without a server explanation unknown', () => {
    expect(swapProviderPresentation({ ...onDemand, detail: undefined }).label).toBe('Unknown')
  })

  test('does not label a partially checked set as all operational', () => {
    const mixed: SwapHealth = { ...health, integrations: [{ ...onDemand, status: 'ok' }, gated] }
    expect(swapHealthSummary(mixed).label).toBe('1/2 providers operational; others unchecked or restricted')
    expect(swapHealthSummary({ ...mixed, integrations: [{ ...onDemand, status: 'ok' }] }).label).toBe('All providers operational (1/1)')
  })

  test('still surfaces a reported outage or degradation', () => {
    expect(swapHealthSummary({ ...health, integrations: [{ ...onDemand, status: 'offline' }] }).label).toContain('offline')
    expect(swapHealthSummary({ ...health, integrations: [{ ...onDemand, status: 'degraded' }] }).label).toContain('degraded')
  })

  test('quote-scoped results describe quote availability without claiming protocol uptime', () => {
    const quoteCheck: SwapIntegrationHealth = { ...onDemand, checkScope: 'quote', checkedAt: health.fetchedAt, status: 'ok', detail: 'Provider returned an executable quote for this pair' }
    expect(swapProviderPresentation(quoteCheck)).toMatchObject({ label: 'Quote available', description: 'Provider returned an executable quote in its latest quote check' })
    for (const status of ['degraded', 'offline'] as const) {
      expect(swapProviderPresentation({ ...quoteCheck, status, detail: undefined }).label).toBe('No quote')
    }
    expect(swapProviderPresentation({ ...quoteCheck, status: 'gated', detail: gated.detail }).label).toBe('Restricted')
    expect(swapProviderPresentation({ ...quoteCheck, checkScope: undefined }).label).toBe('Operational')
    expect(swapHealthQuoteExplanation({ ...health, integrations: [quoteCheck] })).toContain('different asset pairs and amounts')
    expect(swapHealthQuoteExplanation(health)).toBeUndefined()
  })

  test('the nine-provider gateway summary counts seven checked routes and excludes restrictions', () => {
    const integrations: SwapIntegrationHealth[] = [
      ...['thorchain', 'mayachain', 'nearIntents', 'relay', 'uniswap'].map(key => ({ key, label: key, status: 'ok' as const, checkScope: 'quote' as const })),
      ...['zeroex', 'shapeshift'].map(key => ({ key, label: key, status: 'degraded' as const, checkScope: 'quote' as const })),
      gated, { key: 'chainflip', label: 'Chainflip', status: 'disabled' },
    ]
    const summary = swapHealthSummary({ ...health, integrations })
    expect(summary.label).toBe('Recent quote checks: 5/7 providers returned a quote')
    expect(summary.label).not.toMatch(/operational|offline|degraded/)
    expect(summary.bars).toBe(3)
    const allAvailable = integrations.map(integration => integration.status === 'degraded' ? { ...integration, status: 'ok' as const } : integration)
    expect(swapHealthSummary({ ...health, integrations: allAvailable })).toMatchObject({ bars: 4, label: 'Recent quote checks: 7/7 providers returned a quote' })
  })

  test('expired and unchecked observations are separate from fresh failures and available quotes', () => {
    const integrations: SwapIntegrationHealth[] = [
      { ...onDemand, checkScope: 'quote', status: 'ok' },
      { ...onDemand, key: 'nearIntents', checkScope: 'quote', status: 'unknown', detail: 'Last quote check is over five minutes old.' },
      gated,
    ]
    expect(swapHealthSummary({ ...health, integrations }).label).toBe('Recent quote checks: 1/1 providers returned a quote; 1 without a recent quote check')
    expect(swapHealthSummary({ ...health, integrations: [integrations[1], gated] }).label).toBe('No current quote results; request a quote')
    expect(swapHealthSummary({ ...health, integrations: [{ ...integrations[0], status: 'degraded' }, gated] }).label).toBe('Recent quote checks: 0/1 providers returned a quote')
    expect(swapHealthSummary({ ...health, integrations, error: 'HTTP 503' }).label).toBe('Provider status feed unavailable')
  })
})

describe('Pioneer provider status feed', () => {
  test('preserves on-demand and gated explanations from the server', async () => {
    fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(health))
    expect(await fetchSwapHealth('https://oracles.cc')).toEqual(health)
  })

  test('an HTTP failure does not mark all providers offline', async () => {
    fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }))
    const result = await fetchSwapHealth('https://oracles.cc')
    expect(result.error).toContain('status feed is unavailable')
    expect(result.integrations.every(provider => provider.status === 'unknown')).toBe(true)
    expect(swapHealthSummary(result).label).toBe('Provider status feed unavailable')
  })

  test('timeouts and malformed responses also report unavailable status data', async () => {
    fetchMock = spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce(Response.json({ message: 'not a health response' }))
    expect((await fetchSwapHealth('https://oracles.cc')).error).toBeDefined()
    expect((await fetchSwapHealth('https://oracles.cc')).error).toBeDefined()
  })
})
