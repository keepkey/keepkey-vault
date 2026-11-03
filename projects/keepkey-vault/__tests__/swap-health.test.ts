import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { fetchSwapHealth } from '../src/bun/swap-health'
import { swapHealthSummary, swapProviderPresentation } from '../src/shared/swap-health'
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
