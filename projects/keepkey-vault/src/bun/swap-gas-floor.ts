/**
 * Gas prices for swap transactions on EVM chains (gwei).
 *
 * Two different jobs (audit v6 B12):
 * - floor: the least we sign over a live network quote, so a quote that is
 *   too low, or the slow fee level, does not leave the tx stuck in the mempool.
 *   It follows each network's own minimum: BSC validators include from
 *   0.05 gwei (bsc miner.GasPrice default), and Avalanche C-Chain has no fixed
 *   minimum since ACP-176 (the live base fee is the floor). A higher floor only
 *   overpays: the old 3 gwei (BSC) and 25 gwei (Avalanche) were 10–30× the quote.
 * - fallback: what we sign when there is no quote at all (the price service
 *   failed). It stays conservative, since a stuck swap is worse than a high fee.
 */
const FLOOR_GWEI: Record<string, number> = {
  ethereum: 3,
  polygon: 30, // Polygon PoS refuses tips under 25 gwei (PIP-35)
  bsc: 0.05,
  avalanche: 0,
  base: 0.05,
  arbitrum: 0.1,
  optimism: 0.05,
  gnosis: 2,
  monad: 50,
  hyperliquid: 0.1,
}

const FALLBACK_GWEI: Record<string, number> = {
  ...FLOOR_GWEI,
  bsc: 1,
  avalanche: 25,
}

// Chains outside the tables keep the long-standing 10 gwei for both jobs.
const DEFAULT_GWEI = 10
const toWei = (gwei: number) => BigInt(Math.round(gwei * 1e9))

/** Least gas price to sign over a live quote. 0n means the quote itself is the floor. */
export function swapGasFloorWei(chainId: string): bigint {
  return toWei(FLOOR_GWEI[chainId] ?? DEFAULT_GWEI)
}

/** Gas price to sign when no quote could be read. */
export function swapGasFallbackWei(chainId: string): bigint {
  return toWei(FALLBACK_GWEI[chainId] ?? DEFAULT_GWEI)
}

/**
 * Gas price to sign: the live quote raised to the chain floor, or the
 * fallback when there is no usable quote (missing, zero or unreadable).
 */
export function swapGasPriceWei(chainId: string, quoteWei: bigint | null | undefined): bigint {
  if (quoteWei == null || quoteWei <= 0n) return swapGasFallbackWei(chainId)
  if (chainId === 'avalanche') return avalancheWithHeadroom(quoteWei)
  const floor = swapGasFloorWei(chainId)
  return quoteWei < floor ? floor : quoteWei
}

// Avalanche signs legacy txs (chainId ≥ 256), and its quote is base fee + a
// small tip: 25% headroom keeps the tx includable if the base fee rises while
// the user reviews on the device. Still far under the old 25 gwei floor.
const avalancheWithHeadroom = (quoteWei: bigint) => quoteWei * 125n / 100n

/** A Pioneer GetGasPriceByNetwork answer (gwei, plain or {average, fast}) in wei, or null. */
export function pioneerGasQuoteWei(data: unknown): bigint | null {
  const raw = data && typeof data === 'object' ? ((data as any).average || (data as any).fast) : data
  const gwei = parseFloat(String(raw ?? ''))
  return Number.isFinite(gwei) && gwei > 0 ? toWei(gwei) : null
}

/**
 * The least a node accepts, applied after the user's fee level (the slow level
 * signs 80%): with the floors at the network minimum, 80% of it would be
 * refused. BSC validators include from 0.05 gwei; on Avalanche the quote with
 * its headroom. Other chains keep their
 * floors above the network minimum, so the slow level stays as it was.
 */
export function swapGasMinimumWei(chainId: string, quoteWei: bigint | null | undefined): bigint {
  if (chainId === 'bsc') return swapGasFloorWei('bsc')
  if (chainId === 'avalanche' && quoteWei != null && quoteWei > 0n) return avalancheWithHeadroom(quoteWei)
  return 0n
}
