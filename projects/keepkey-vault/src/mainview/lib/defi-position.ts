import { CHAINS } from '../../shared/chains'
import type { DefiPosition } from '../../shared/types'

export function defiPositionName(position: DefiPosition): string {
  return position.name || position.displayName || position.symbol || position.protocol || 'DeFi Position'
}

// Only known protocol destinations; never construct a domain from API labels.
const PROTOCOL_URLS: Record<string, string> = {
  aerodrome: 'https://aerodrome.finance/dash',
  'aerodrome-finance': 'https://aerodrome.finance/dash',
  'aerodrome-v2': 'https://aerodrome.finance/dash',
  'aerodrome-slipstream': 'https://aerodrome.finance/dash',
  aave: 'https://app.aave.com',
  'aave-v2': 'https://app.aave.com',
  'aave-v3': 'https://app.aave.com',
  uniswap: 'https://app.uniswap.org',
  'uniswap-v2': 'https://app.uniswap.org',
  'uniswap-v3': 'https://app.uniswap.org',
  'uniswap-v4': 'https://app.uniswap.org',
  lido: 'https://stake.lido.fi',
  curve: 'https://www.curve.finance',
  yearn: 'https://yearn.fi',
  'yearn-v2': 'https://yearn.fi',
  'yearn-v3': 'https://yearn.fi',
}

export function defiProtocolUrl(protocol: string | null): string | undefined {
  const url = protocol ? PROTOCOL_URLS[protocol.toLowerCase()] : undefined
  return typeof url === 'string' ? url : undefined
}

export function isNativeDefiToken(address: string): boolean {
  return /^0x(?:0{40}|e{40})$/i.test(address)
}

/** Resolve each token's own network first; never guess Ethereum for unknown chains. */
export function defiExplorerUrl(
  position: Pick<DefiPosition, 'networkId' | 'network'>,
  address: string | null | undefined,
  tokenNetworkId?: string,
): string | undefined {
  if (!address || !/^0x[0-9a-f]{40}$/i.test(address)) return undefined
  const networkId = tokenNetworkId || position.networkId
  const network = position.network.toLowerCase()
  const chain = networkId
    ? CHAINS.find(c => c.networkId === networkId)
    : CHAINS.find(c => c.chainFamily === 'evm' && (
      c.id === network || c.coin.toLowerCase() === network || c.networkId === network
    ))
  return chain?.explorerAddressUrl?.replace('{{address}}', address)
}


/** Destinations come from the protocol registry, never from untrusted API URLs.
 * Aerodrome route contract verified against its official app on 2026-11-15. */
export function defiManagementLinks(position: Pick<DefiPosition, 'protocol' | 'displayName' | 'network' | 'networkId' | 'tokens'>): {
  url: string; protocol: string; poolUrl?: string
} | undefined {
  const id = position.protocol?.trim().toLowerCase()
  const url = defiProtocolUrl(id || null)
  if (!url) return undefined
  if (id?.startsWith('aerodrome')) {
    const base = position.networkId ? position.networkId === 'eip155:8453'
      : ['base', 'eip155:8453'].includes(position.network.toLowerCase())
    if (!base) return undefined
    const tokens = [...new Set((position.tokens || [])
      .filter(token => token.networkId === 'eip155:8453' && /^0x[0-9a-f]{40}$/i.test(token.address) && !isNativeDefiToken(token.address))
      .map(token => token.address.toLowerCase()))]
    // A single underlying coin is not an LP pool identifier. A known pair can
    // narrow the pool list; type/factory/NFT ids would be needed for /deposit.
    const poolUrl = tokens.length === 2 ? `https://aerodrome.finance/pools?${new URLSearchParams({
      token0: tokens[0], token1: tokens[1], chain: '8453', chain0: '8453', chain1: '8453',
    }).toString()}` : undefined
    return { url, protocol: 'Aerodrome', poolUrl }
  }
  const names: Record<string, string> = { aave: 'Aave', uniswap: 'Uniswap', lido: 'Lido', curve: 'Curve', yearn: 'Yearn' }
  return { url, protocol: names[id!.split('-')[0]] || position.displayName || position.protocol! }
}
