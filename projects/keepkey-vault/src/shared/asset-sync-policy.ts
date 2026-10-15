import { NATIVE_IDENTITIES } from './symbolSquatter'

/**
 * Being in assetData.json exempts a token from the symbol-squatter warning, so
 * the discovery sync must not add a token whose symbol IS a chain ticker:
 * pioneer-discovery lists Solana memecoins with symbol ETH, BTC, DOGE, SOLANA.
 * Real tokens the sync exists for (TRON USDT, mSOL, cbBTC) carry the chain only
 * in their name. A legitimate one with a native ticker is curated by hand.
 */
// Native tickers that are legitimately issued as tokens: wrapped SOL, and
// assets THORChain/Maya issue on their own chain (secured and synth assets).
const NATIVE_TICKER_ISSUERS = [
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:So11111111111111111111111111111111111111112',
  'cosmos:thorchain-mainnet-v1/denom:',
  'cosmos:mayachain-mainnet-v1/denom:',
]

export function syncSkips(caip: string, symbol: unknown): boolean {
  const isToken = !caip.includes('/slip44:')
  // x/ denoms are made by contracts, not the protocol: never exempt.
  const issued = NATIVE_TICKER_ISSUERS.some((issuer) => caip.startsWith(issuer) && !caip.startsWith(`${issuer}x/`))
  return isToken && typeof symbol === 'string' && NATIVE_IDENTITIES.has(symbol.trim().toUpperCase()) && !issued
}
