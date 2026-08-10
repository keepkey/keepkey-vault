export interface PortfolioExtraContract {
  networkId: string
  contractAddress: string
  decimals: number
  symbol?: string
  name?: string
  icon?: string
}

const contractKey = (entry: PortfolioExtraContract): string =>
  `${entry.networkId.toLowerCase()}:${entry.contractAddress.toLowerCase()}`

/** Pioneer caps extraContracts at 20. Put post-swap reconciliation targets
 * first, then append custom tokens without duplicating a target contract. */
export function prioritizeExtraContracts(
  swapDestinations: PortfolioExtraContract[],
  customContracts: PortfolioExtraContract[],
): PortfolioExtraContract[] {
  const result: PortfolioExtraContract[] = []
  const seen = new Set<string>()
  for (const entry of [...swapDestinations, ...customContracts]) {
    const key = contractKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(entry)
  }
  return result
}
