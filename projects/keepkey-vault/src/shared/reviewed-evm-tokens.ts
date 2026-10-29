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

/**
 * Tokens named only inside a certified Uniswap swap entry (0x07) and the
 * swap preview. Their approve/transfer descriptions stay with the signed
 * discovered-token catalog: listing them in REVIEWED_EVM_TOKENS would make
 * Desktop expect a reviewed approve/transfer body that the service does not
 * serve for them, and those calls would fail.
 *
 * Major tokens only. Each one is on the Uniswap Labs Default list v22.32.0
 * with this symbol and these decimals, is in the worker's majors-only token
 * snapshot with the same identity (so the swap names a token the same way
 * its approve does), and has this symbol()/decimals() on chain (public RPC,
 * eth_chainId checked), checked 2026-10-29.
 */
export const REVIEWED_SWAP_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '1:0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
  '1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  '1:0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 },
  '1:0xc770eefad204b5180df6a14ee197d99d808ee52d': { symbol: 'FOX', decimals: 18 },
  '1:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC', decimals: 8 },
  '1:0x514910771af9ca656af840dff83e8264ecf986ca': { symbol: 'LINK', decimals: 18 },
  '10:0x4200000000000000000000000000000000000042': { symbol: 'OP', decimals: 18 },
  '10:0xef4461891dfb3ac8572ccf7c794664a8dd927945': { symbol: 'WCT', decimals: 18 },
  '8453:0xf4d97f2da56e8c3098f3a8d538db630a2606a024': { symbol: 'DIEM', decimals: 18 },
}

/**
 * Names for the USDC/USDT an Across deposit pays out, so a normal stablecoin
 * route is not "a token this computer cannot name". Naming ONLY: this map
 * never feeds the certified catalog (that stays REVIEWED_EVM_TOKENS).
 *
 * One entry per USDC, USDC.e and USDT output token the Across API
 * (app.across.to/api/available-routes) routes to a chain in
 * REVIEWED_ACROSS_SPOKE_POOLS, minus those already above. Checked 2026-10-16:
 * symbol()/decimals() via public RPC (eth_chainId equal to the chain), and
 * the same address and decimals on the Uniswap Labs Default list v22.27.0.
 * The symbol is the list's. Where the contract's symbol() differs:
 *   USDC.e on 10, 137, 480, 42161: symbol() is "USDC"; the list marks it bridged.
 *   USDT0 on 130: symbol() is "USD₮0" (not ASCII).
 *   USDT on 137: symbol() is "USDT0".  USDT on 43114: symbol() is "USDt".
 * Not on the Uniswap list, checked another way instead:
 *   324 (zkSync): the canonical bridge 0x11f943b2c77b743ab90f4a0ae7d5a4e7fca3e102
 *     maps Ethereum USDC/USDT to these (l2TokenAddress), symbol() agrees.
 *   59144 (Linea): Consensys linea-token-list shortlist, bridged from Ethereum
 *     USDC/USDT, symbol() agrees.
 * Across routes no USDC/USDT to Blast, Scroll or Zora, so none is listed there.
 */
export const ACROSS_NAMED_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  '1:0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
  '10:0x0b2c639c533813f4aa9d7837caf62653d097ff85': { symbol: 'USDC', decimals: 6 },
  '10:0x7f5c764cbc14f9669b88837ca1490cca17c31607': { symbol: 'USDC.e', decimals: 6 },
  '10:0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': { symbol: 'USDT', decimals: 6 },
  '56:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC', decimals: 18 },
  '56:0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', decimals: 18 },
  '130:0x078d782b760474a361dda0af3839290b0ef57ad6': { symbol: 'USDC', decimals: 6 },
  '130:0x9151434b16b9763660705744891fa906f660ecc5': { symbol: 'USDT0', decimals: 6 },
  '137:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { symbol: 'USDC', decimals: 6 },
  '137:0x2791bca1f2de4661ed88a30c99a7a9449aa84174': { symbol: 'USDC.e', decimals: 6 },
  '137:0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { symbol: 'USDT', decimals: 6 },
  '324:0x3355df6d4c9c3035724fd0e3914de96a5a83aaf4': { symbol: 'USDC.e', decimals: 6 },
  '324:0x493257fd37edb34451f62edf8d2a0c418852ba4c': { symbol: 'USDT', decimals: 6 },
  '480:0x79a02482a880bce3f13e09da970dc34db4cd24d1': { symbol: 'USDC.e', decimals: 6 },
  '8453:0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': { symbol: 'USDT', decimals: 6 },
  '42161:0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': { symbol: 'USDC.e', decimals: 6 },
  '43114:0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': { symbol: 'USDC', decimals: 6 },
  '43114:0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7': { symbol: 'USDT', decimals: 6 },
  '59144:0x176211869ca2b568f2a7d4ee941e073a821ee1ff': { symbol: 'USDC', decimals: 6 },
  '59144:0xa219439258ca9da29e9cc4ce5596924745e12b93': { symbol: 'USDT', decimals: 6 },
}
