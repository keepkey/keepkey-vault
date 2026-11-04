import { assetData } from '@pioneer-platform/pioneer-discovery'
import { CHAINS, isChainSupported, type ChainDef } from '../shared/chains'
import { canonicalizeCaip } from '../shared/swap-discovery'
import type { SwapAsset } from '../shared/types'

export const swapAssetKey = (value: string) => {
  const key = canonicalizeCaip(value)
  return key.startsWith('eip155:') ? key.toLowerCase() : key
}
const metadata = new Map(Object.entries(assetData).map(([key, row]) => [swapAssetKey(key), row as any]))

/** Resolve metadata independently of the provider's short pool list. Routing
 * availability is established by a quote, never by membership in that list. */
export async function resolveSwapAsset(key: string, options: {
  assets: SwapAsset[]; firmwareVersion?: string; chains?: ChainDef[]
  tokenDecimals?: (network: string, contract: string) => Promise<number | undefined>
}): Promise<SwapAsset | null> {
  const canonical = swapAssetKey(key)
  const known = options.assets.find(a => a.asset === key || (a.caip && swapAssetKey(a.caip) === canonical))
  const chains = options.chains || CHAINS
  if (known) return chains.some(c => c.id === known.chainId && isChainSupported(c, options.firmwareVersion)) ? known : null
  const slash = canonical.indexOf('/')
  if (slash < 0) return null
  const network = canonical.slice(0, slash), chain = chains.find(c => c.networkId === network)
  if (!chain || !isChainSupported(chain, options.firmwareVersion)) return null
  const native = swapAssetKey(chain.caip) === canonical
  const contract = /^eip155:\d+\/erc20:(0x[0-9a-f]{40})$/.exec(canonical)?.[1]
    || /^(?:solana:[^/]+|tron:[^/]+)\/token:([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(canonical)?.[1]
  if (!native && !contract) return null
  const row = metadata.get(canonical)
  let decimals = native ? chain.decimals : row?.decimals ?? row?.precision
  if (decimals == null && contract && chain.chainFamily === 'evm' && options.tokenDecimals) {
    decimals = await options.tokenDecimals(network, contract)
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null
  const symbol = native ? chain.symbol : row?.symbol || `Token ${contract!.slice(0, 8)}`
  return { asset: `${chain.id.toUpperCase()}.${symbol}${contract ? '-' + contract.toUpperCase() : ''}`,
    caip: canonical, chainId: chain.id, chainFamily: chain.chainFamily, decimals,
    symbol, name: row?.name || (native ? chain.coin : symbol), contractAddress: contract, icon: row?.icon }
}
