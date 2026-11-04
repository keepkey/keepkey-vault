import catalog from './evm-token-identities.json'

// Host labels are exact catalog matches, never a device authentication claim.
const tokens: Record<string, { symbol: string; decimals: number }> = {
  ...catalog.tokens,
  // Reviewed static schemas remain available when discovery lacks decimals.
  '42161:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', decimals: 6 },
  '1:0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
  // Canonical WETH, missing from the discovery catalog: WETH9 on Ethereum,
  // the OP Stack predeploy on Base and Optimism, Arbitrum's bridged WETH.
  // symbol() "WETH" and decimals() 18 read on chain 2026-10-30.
  '1:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 },
  '8453:0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
  '10:0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
  '42161:0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { symbol: 'WETH', decimals: 18 },
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
