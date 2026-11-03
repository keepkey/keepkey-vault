import type { SwapHealth } from '../shared/types'

/** A status endpoint failure says nothing about the individual providers. */
export async function fetchSwapHealth(base: string): Promise<SwapHealth> {
  try {
    const response = await fetch(`${base}/api/v1/swap/health`, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json() as SwapHealth
    if (!Array.isArray(data.integrations) || !Number.isFinite(data.fetchedAt)) throw new Error('Invalid provider status response')
    return data
  } catch (error) {
    console.warn('[swap] getSwapHealth failed:', error instanceof Error ? error.message : error)
    const detail = 'Pioneer’s provider status feed is unavailable. Request a quote to check routes for your pair.'
    return {
      fetchedAt: Date.now(),
      error: detail,
      integrations: [
        { key: 'thorchain', label: 'THORChain', status: 'unknown', detail },
        { key: 'mayachain', label: 'Mayachain', status: 'unknown', detail },
        { key: 'shapeshift', label: 'ShapeShift', status: 'unknown', detail },
        { key: 'relay', label: 'Relay', status: 'unknown', detail },
      ],
    }
  }
}
