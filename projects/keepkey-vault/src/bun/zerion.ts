/** Demand-driven Zerion DeFi positions client for the configured Pioneer provider. */
import type { DefiPosition } from '../shared/types'
import { ensurePioneerQueryKeyRegistered, getPioneerApiBase, getQueryKey } from './pioneer'

const ZERION_TIMEOUT_MS = 20_000
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/

/**
 * Fetch supplementary DeFi positions for one EVM address. The gateway owns
 * Zerion credentials and normalization; Vault only consumes the stable Pioneer
 * contract. No request is made until the panel is actively rendered.
 */
export async function fetchDefiPositions(address: string): Promise<DefiPosition[]> {
  if (!EVM_ADDRESS.test(address || '')) return []
  const base = getPioneerApiBase()
  try {
    await ensurePioneerQueryKeyRegistered()
    const resp = await fetch(`${base}/api/v1/zerion/positions/${address}`, {
      headers: { Accept: 'application/json', Authorization: getQueryKey() },
      signal: AbortSignal.timeout(ZERION_TIMEOUT_MS),
    })
    if (!resp.ok) {
      console.warn(`[Zerion] ${resp.status} fetching positions for ${address}`)
      return []
    }
    const body = await resp.json() as any
    const raw = Array.isArray(body?.positions) ? body.positions : []
    const positions: DefiPosition[] = raw.map((position: any) => ({
      protocol: position?.protocol || null,
      displayName: String(position?.displayName || position?.label || position?.protocol || 'DeFi Position'),
      name: String(position?.label || position?.displayName || position?.protocol || 'DeFi Position'),
      network: String(position?.network || ''),
      networkId: typeof position?.networkId === 'string' ? position.networkId : undefined,
      balanceUsd: Number(position?.balanceUsd) || 0,
      icon: typeof position?.icon === 'string' ? position.icon : undefined,
      type: 'contract-position',
      metaType: typeof position?.positionType === 'string' ? position.positionType : null,
      tokens: Array.isArray(position?.tokens) ? position.tokens.map((token: any) => ({
        networkId: String(token?.networkId || position?.networkId || ''),
        address: String(token?.address || '').toLowerCase(),
        symbol: typeof token?.symbol === 'string' ? token.symbol : undefined,
        balance: token?.balance == null ? undefined : String(token.balance),
        balanceUsd: Number.isFinite(Number(token?.balanceUsd)) ? Number(token.balanceUsd) : undefined,
      })).filter((token: any) => token.address) : [],
    }))
    console.log(`[Zerion] ${positions.length} DeFi positions for ${address.slice(0, 10)}…`)
    return positions
  } catch (e: any) {
    console.warn(`[Zerion] fetch failed for ${address}:`, e?.message || e)
    return []
  }
}
