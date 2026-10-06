import catalog from './evm-token-identities.json'

// Host labels are exact catalog matches, never a device authentication claim.
const tokens: Record<string, { symbol: string; decimals: number }> = {
  ...catalog.tokens,
  // Reviewed static schemas remain available when discovery lacks decimals.
  '42161:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', decimals: 6 },
  '1:0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
}
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const PERMIT2_CHAINS = new Set([1, 10, 30, 56, 137, 10143, 42161, 42220, 43114, 4663, 5042, 8453, 57073, 59144, 81457, 11155111])
const CONTRACTS: Record<string, string> = {
  '42161:0x2d01411773c8c24805306e89a41f7855c3c4fe65': 'Uniswap Universal Router',
}

export function evmTokenIdentity(chainId: number, address: string) {
  return tokens[`${chainId}:${address.toLowerCase()}`]
}

export function evmContractIdentity(chainId: number, address: string): string | undefined {
  if (PERMIT2_CHAINS.has(chainId) && address.toLowerCase() === PERMIT2) return 'Uniswap Permit2'
  const contract = CONTRACTS[`${chainId}:${address.toLowerCase()}`]
  if (contract) return contract
  return evmTokenIdentity(chainId, address)?.symbol
}
