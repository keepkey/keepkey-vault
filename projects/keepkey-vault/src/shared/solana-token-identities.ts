/**
 * Solana mints the risk bar names by symbol. Every other mint is shown as
 * base units plus its full address: a ticker nobody checked is how a fake
 * token passes for a real one.
 *
 * Each entry: the issuer's own page, and a getAccountInfo (jsonParsed) on
 * mainnet, 2026-10-29, confirming the owning token program and decimals.
 */
export const SOLANA_TOKEN_IDENTITIES: Record<string, { symbol: string; decimals: number }> = {
  // Native mint (wrapped SOL), SPL Token, 9 decimals.
  // https://github.com/solana-program/token/blob/main/interface/src/native_mint.rs
  So11111111111111111111111111111111111111112: { symbol: 'SOL', decimals: 9 },
  // USDC, SPL Token, 6 decimals. https://developers.circle.com/stablecoins/usdc-contract-addresses
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
  // USDT, SPL Token, 6 decimals. https://tether.to/en/supported-protocols/
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6 },
  // PYUSD, Token-2022, 6 decimals. https://docs.paxos.com/guides/stablecoin/pyusd/mainnet
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': { symbol: 'PYUSD', decimals: 6 },
}
