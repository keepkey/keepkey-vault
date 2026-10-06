/**
 * Reviewed ERC-20 deployments. KeepKey names the amount with this symbol, so a
 * token is listed by address only, never looked up by symbol (look-alikes
 * share symbols). Each entry agrees across the Uniswap Labs Default list
 * v22.24.0 and the contract's own symbol()/decimals(), checked 2026-10-03,
 * except one symbol: Arbitrum USDT0's symbol() is "USD₮0" (not ASCII, which
 * the device needs); "USDT0" is the list's ASCII transliteration. Its
 * decimals() agrees.
 */
export const REVIEWED_EVM_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
  '8453:0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', decimals: 6 },
  '8453:0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
  '8453:0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI', decimals: 18 },
  '8453:0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': { symbol: 'cbBTC', decimals: 8 },
  '8453:0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': { symbol: 'cbETH', decimals: 18 },
  '42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC', decimals: 6 },
  '42161:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT0', decimals: 6 },
  '42161:0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { symbol: 'WETH', decimals: 18 },
  '42161:0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18 },
  '42161:0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': { symbol: 'WBTC', decimals: 8 },
}
