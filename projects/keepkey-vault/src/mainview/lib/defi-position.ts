import { CHAINS } from '../../shared/chains'
import type { DefiPosition } from '../../shared/types'

export function defiPositionName(position: DefiPosition): string {
  return position.name || position.displayName || position.symbol || position.protocol || 'DeFi Position'
}

// Only known protocol destinations; never construct a domain from API labels.
const PROTOCOL_URLS: Record<string, string> = {
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
