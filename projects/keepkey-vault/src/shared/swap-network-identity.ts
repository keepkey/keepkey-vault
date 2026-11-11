import { CHAINS } from './chains'
import { normalizeAssetCaip } from './balance-reconciliation'
import { canonicalizeCaip, canonicalizeChainCaip2, networkDisplayName } from './swap-discovery'

interface SwapNetworkAsset {
  chainId: string
  asset?: string
  caip?: string
  contractAddress?: string
}

function canonicalNetwork(value: string): string {
  const network = canonicalizeChainCaip2(value)
  return network.startsWith('eip155:') ? network.toLowerCase() : network
}

/** Resolve the displayed network from its actual CAIP identity, never its
 * ticker. A disagreeing backend chain id is flagged before a quote/signature. */
export function swapNetworkIdentity(asset: SwapNetworkAsset) {
  const declared = CHAINS.find(chain => chain.id === asset.chainId)
  const declaredNetwork = canonicalNetwork(declared?.networkId || declared?.caip.split('/')[0] || '')
  const assetNetwork = canonicalNetwork(asset.caip?.split('/')[0] || '')
  const networkId = assetNetwork || declaredNetwork || asset.chainId
  const canonical = CHAINS.find(chain => canonicalNetwork(chain.networkId || chain.caip.split('/')[0]) === networkId)
  return {
    networkId,
    name: networkDisplayName(networkId),
    chainCaip: canonical?.caip ? canonicalizeCaip(canonical.caip) : undefined,
    color: canonical?.color,
    assetCaip: asset.caip ? canonicalizeCaip(asset.caip) : (!asset.contractAddress && canonical?.caip ? canonicalizeCaip(canonical.caip) : undefined),
    conflict: !!assetNetwork && !!declaredNetwork && assetNetwork !== declaredNetwork,
  }
}

/** ETH on two different networks is a route, not a same-asset self-swap. */
export function sameSwapAsset(left: SwapNetworkAsset, right: SwapNetworkAsset): boolean {
  if (left.caip && right.caip) return normalizeAssetCaip(canonicalizeCaip(left.caip)) === normalizeAssetCaip(canonicalizeCaip(right.caip))
  return !!left.asset && left.chainId === right.chainId && left.asset === right.asset
}
