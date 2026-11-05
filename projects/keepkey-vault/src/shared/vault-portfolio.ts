import type { ChainBalance } from './types'
import type { VaultIdentity } from './vault-identity'

/** A shared account has its own balances; never substitute an owner's wallet. */
export interface VaultPortfolio {
  identity: VaultIdentity
  balance?: ChainBalance
  /** Undefined means some held assets cannot currently be valued. */
  totalUsd?: number
  includeInTotal: boolean
  updatedAt?: number
  error?: string
}

export const vaultPortfolioAccountKey = (vault: VaultIdentity): string =>
  `${vault.networkId}:${vault.type === 'safe' ? vault.address.toLowerCase() : vault.address}`

const equalAddress = (a: string, b: string) => /^0x/i.test(a) && /^0x/i.test(b)
  ? a.toLowerCase() === b.toLowerCase() : a === b

/** Check responses before displaying them in the selected vault's wallet UI. */
export function assertVaultPortfolioResponse(expected: VaultIdentity, result: VaultPortfolio): void {
  const actual = result?.identity
  if (!actual || actual.id !== expected.id || actual.type !== expected.type ||
      actual.chainId !== expected.chainId || actual.networkId !== expected.networkId ||
      !equalAddress(actual.address, expected.address) ||
      !equalAddress(actual.accountId, expected.accountId)) {
    throw new Error('Vault portfolio belongs to a different account or network')
  }
  if (result.totalUsd !== undefined && (!Number.isFinite(result.totalUsd) || result.totalUsd < 0)) {
    throw new Error('Invalid vault valuation')
  }
  const balance = result.balance
  if (!balance) {
    if (result.totalUsd !== undefined) throw new Error('Vault valuation has no verified balance')
    return
  }
  if (balance.chainId !== expected.chainId || !equalAddress(balance.address, expected.address)) {
    throw new Error('Vault balance belongs to a different account or network')
  }
  for (const token of balance.tokens || []) {
    const asset = expected.supportedAssets.find(a => a.caip.toLowerCase() === token.caip.toLowerCase())
    if (!asset || token.networkId !== expected.networkId ||
        !token.caip.startsWith(expected.networkId + '/') ||
        (token.decimals !== undefined && token.decimals !== asset.decimals) ||
        (asset.contract && (!token.contractAddress || !equalAddress(token.contractAddress, asset.contract)))) {
      throw new Error('Vault token belongs to a different asset or network')
    }
  }
}

/** Count each exact shared account once, even when several cosigners list it. */
export function includedVaultTotal(portfolios: readonly VaultPortfolio[]): { totalUsd: number; partial: boolean } {
  const seen = new Set<string>()
  let totalUsd = 0
  let partial = false
  for (const portfolio of portfolios) {
    const key = vaultPortfolioAccountKey(portfolio.identity)
    if (seen.has(key)) continue
    seen.add(key)
    if (!portfolio.includeInTotal) continue
    if (portfolio.totalUsd === undefined || !Number.isFinite(portfolio.totalUsd) || portfolio.totalUsd < 0) partial = true
    else totalUsd += portfolio.totalUsd
  }
  return { totalUsd, partial }
}
