import type { SwapHealth, SwapIntegrationHealth } from './types'

export function swapProviderPresentation(integration: SwapIntegrationHealth) {
  if (integration.checkScope === 'quote' && ['ok', 'degraded', 'offline', 'unknown'].includes(integration.status)) {
    const available = integration.status === 'ok'
    const unchecked = integration.status === 'unknown'
    const fallback = unchecked
      ? 'No current quote result. Request a quote to check availability.'
      : available ? 'The latest server quote request returned a route. Availability depends on the pair and amount.'
      : 'The latest server quote request returned no usable route. Availability depends on the pair and amount.'
    // Older gateways described global demand observations as "this pair".
    // The status endpoint has no selected-pair context.
    const detail = integration.detail?.replace(/\bfor (?:this|the selected) pair\b/gi, 'in its latest quote check')
    return { label: unchecked ? 'On demand' : available ? 'Quote available' : 'No quote',
      color: unchecked ? '#6b7280' : available ? '#22c55e' : '#f59e0b', description: detail || fallback }
  }
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

export function swapHealthQuoteExplanation(health: SwapHealth): string | undefined {
  if (!health.integrations.some(integration => integration.checkScope === 'quote')) return undefined
  return 'Recent server quote checks may cover different asset pairs and amounts. Request a quote to check availability for your swap.'
}

export function swapHealthSummary(health: SwapHealth) {
  if (health.error) return { color: '#6b7280', bars: 2, label: 'Provider status feed unavailable' }
  if (health.integrations.some(integration => integration.checkScope === 'quote')) {
    const eligible = health.integrations.filter(integration => integration.status !== 'gated' && integration.status !== 'disabled')
    const checked = eligible.filter(integration => integration.checkScope === 'quote' && ['ok', 'degraded', 'offline'].includes(integration.status))
    const available = checked.filter(integration => integration.status === 'ok').length
    if (!checked.length) return { color: '#6b7280', bars: 2, label: 'No current quote results; request a quote' }
    const unchecked = eligible.length - checked.length
    const label = `Recent quote checks: ${available}/${checked.length} providers returned a quote${unchecked ? `; ${unchecked} without a recent quote check` : ''}`
    return { color: available === checked.length ? '#22c55e' : '#f59e0b', bars: available === checked.length ? 4 : available ? 3 : 1, label }
  }
  const statuses = health.integrations.map(integration => integration.status)
  const okCount = statuses.filter(status => status === 'ok').length
  const total = statuses.length
  if (statuses.includes('offline')) return { color: '#ef4444', bars: 1, label: `Provider(s) offline (${okCount}/${total} operational)` }
  if (statuses.includes('degraded')) return { color: '#f59e0b', bars: 3, label: `Some providers degraded (${okCount}/${total} operational)` }
  if (total > 0 && okCount === total) return { color: '#22c55e', bars: 4, label: `All providers operational (${okCount}/${total})` }
  if (okCount > 0) return { color: '#6b7280', bars: 2, label: `${okCount}/${total} providers operational; others unchecked or restricted` }
  const onDemand = health.integrations.some(integration => integration.status === 'unknown' && /quote demand/i.test(integration.detail || ''))
  return { color: '#6b7280', bars: 2, label: onDemand ? 'Provider availability is checked when requesting a quote' : 'Provider status unknown or restricted' }
}
