import { getSetting } from './db'

export type EvmSimulationRpcUrls = Record<string, string>

export function getEvmSimulationRpcUrls(): EvmSimulationRpcUrls {
  try {
    const parsed = JSON.parse(getSetting('evm_simulation_rpc_urls') || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([chainId, url]) =>
      /^\d+$/.test(chainId) && typeof url === 'string' && /^https?:\/\//i.test(url))) as EvmSimulationRpcUrls
  } catch { return {} }
}

export function getEvmSimulationEndpoint(chainId: number): string {
  return getEvmSimulationRpcUrls()[String(chainId)] || `eip155:${chainId}`
}
