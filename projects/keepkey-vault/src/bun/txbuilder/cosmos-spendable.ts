/** Demand-only chain reads for transaction safety; never a portfolio snapshot. */
export const COSMOS_REST: Record<string, readonly string[]> = {
  cosmos: ['https://rest.cosmos.directory/cosmoshub', 'https://cosmos-rest.publicnode.com'],
  osmosis: ['https://lcd.osmosis.zone', 'https://rest.cosmos.directory/osmosis'],
  thorchain: ['https://thornode.ninerealms.com', 'https://rest.cosmos.directory/thorchain'],
  mayachain: ['https://mayanode.mayachain.info', 'https://rest.cosmos.directory/mayachain'],
}

export async function getCosmosSpendable(chainId: string, address: string): Promise<Map<string, bigint>> {
  for (const endpoint of COSMOS_REST[chainId] ?? []) {
    try {
      const response = await fetch(`${endpoint}/cosmos/bank/v1beta1/spendable_balances/${encodeURIComponent(address)}?pagination.limit=1000`, {
        cache: 'no-store', signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' },
      })
      if (!response.ok) continue
      const body = await response.json() as any
      if (!Array.isArray(body.balances) || body.pagination?.next_key) continue
      const balances = new Map<string, bigint>()
      for (const coin of body.balances) {
        if (typeof coin.denom !== 'string' || typeof coin.amount !== 'string' || !/^\d+$/.test(coin.amount) || balances.has(coin.denom)) throw new Error('Invalid bank response')
        balances.set(coin.denom, BigInt(coin.amount))
      }
      return balances
    } catch { /* Try the next read endpoint. Never substitute a cached balance. */ }
  }
  throw new Error(`Unable to verify ${chainId} spendable balance on chain. No transaction was built.`)
}
