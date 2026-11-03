import type { SwapHealth, SwapIntegrationHealth } from './types'

export function swapProviderPresentation(integration: SwapIntegrationHealth) {
  const onDemand = integration.status === 'unknown' && /quote demand/i.test(integration.detail || '')
  const defaults = {
    ok: { label: 'Operational', color: '#22c55e', description: 'Provider status check succeeded. Availability still depends on the selected pair.' },
    degraded: { label: 'Degraded', color: '#f59e0b', description: 'Some trading pairs are unavailable. Swaps on other pairs may still work.' },
    offline: { label: 'Offline', color: '#ef4444', description: 'Pioneer reports this provider is unreachable. Quotes requiring this route may fail.' },
    disabled: { label: 'Disabled', color: '#6b7280', description: 'This provider is not configured on the selected server.' },
    gated: { label: 'Restricted', color: '#f59e0b', description: 'This route is available only when the server’s requirements are met.' },
    unknown: { label: onDemand ? 'On demand' : 'Unknown', color: '#6b7280', description: 'Status could not be determined.' },
  }
  const presentation = defaults[integration.status] || defaults.unknown
  return { ...presentation, description: integration.detail || presentation.description }
}

export function swapHealthSummary(health: SwapHealth) {
  const statuses = health.integrations.map(integration => integration.status)
  const okCount = statuses.filter(status => status === 'ok').length
  const total = statuses.length
  if (health.error) return { color: '#6b7280', bars: 2, label: 'Provider status feed unavailable' }
  if (statuses.includes('offline')) return { color: '#ef4444', bars: 1, label: `Provider(s) offline (${okCount}/${total} operational)` }
  if (statuses.includes('degraded')) return { color: '#f59e0b', bars: 3, label: `Some providers degraded (${okCount}/${total} operational)` }
  if (total > 0 && okCount === total) return { color: '#22c55e', bars: 4, label: `All providers operational (${okCount}/${total})` }
  if (okCount > 0) return { color: '#6b7280', bars: 2, label: `${okCount}/${total} providers operational; others unchecked or restricted` }
  const onDemand = health.integrations.some(integration => integration.status === 'unknown' && /quote demand/i.test(integration.detail || ''))
  return { color: '#6b7280', bars: 2, label: onDemand ? 'Provider availability is checked when requesting a quote' : 'Provider status unknown or restricted' }
}
