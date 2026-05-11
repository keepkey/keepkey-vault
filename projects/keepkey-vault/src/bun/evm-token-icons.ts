/**
 * Logo resolver for custom EVM tokens via CoinGecko.
 *
 * `/coins/{platform}/contract/{address}` returns `image.{thumb,small,large}`.
 * No API key required (free tier ~10–30 rpm — caller caches the resolved URL
 * on the custom-token DB row so we only hit CoinGecko on first add).
 *
 * Returns `null` for unknown contracts, unsupported chains, network errors,
 * and rate-limit responses. The caller falls back to the lettered AssetIcon
 * avatar in all those cases.
 *
 * CoinGecko has the deepest coverage of any free token-metadata service we
 * could find (~17k tokens vs TrustWallet's ~10k), so going single-source
 * here is a deliberate simplification — adding another fallback would buy
 * marginal hit-rate at the cost of another HTTP probe per add.
 */

// vault chainId → CoinGecko `asset_platforms.id`. Only chains CoinGecko
// indexes — others return null, which the caller handles.
const COINGECKO_PLATFORM: Record<string, string> = {
  ethereum: 'ethereum',
  bsc: 'binance-smart-chain',
  polygon: 'polygon-pos',
  base: 'base',
  arbitrum: 'arbitrum-one',
  optimism: 'optimistic-ethereum',
  avalanche: 'avalanche',
  fantom: 'fantom',
  gnosis: 'xdai',
}

const FETCH_TIMEOUT_MS = 5000

/**
 * Resolve a logo URL for an ERC-20 contract via CoinGecko.
 * Returns `null` when the chain isn't indexed, the token isn't known,
 * or the request times out / is rate-limited.
 */
export async function resolveTokenIcon(chainId: string, address: string): Promise<string | null> {
  const platform = COINGECKO_PLATFORM[chainId]
  if (!platform) return null
  const url = `https://api.coingecko.com/api/v3/coins/${platform}/contract/${address.toLowerCase()}`
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    const r = await fetch(url, { signal: ctrl.signal })
    clearTimeout(t)
    if (!r.ok) return null
    const j = await r.json() as any
    return j?.image?.large || j?.image?.small || j?.image?.thumb || null
  } catch {
    return null
  }
}
