/**
 * NFT marketplace contracts Desktop names: Seaport 1.6, OpenSea's fee address
 * and conduit, and Blur's transfer operators. Host-side naming only; the
 * device never sees these. Every address comes from the project's own
 * published list and was checked on chain on 2026-10-29 (eth_getCode through
 * public RPCs, and the calls noted below) on every chain listed.
 */

// Seaport 1.6: https://github.com/ProjectOpenSea/seaport#deployments
// information() returns version "1.6" and the domain separator for
// ("Seaport", "1.6", chainId, this address) on each chain below.
export const SEAPORT_1_6 = '0x0000000000000068f116a894984e2db1123eb395'
export const SEAPORT_1_6_CHAINS = new Set([1, 10, 56, 137, 8453, 42161, 43114])

// OpenSea: https://github.com/ProjectOpenSea/opensea-js/blob/main/src/constants.ts
// (OPENSEA_FEE_RECIPIENT, OPENSEA_CONDUIT_KEY, OPENSEA_CONDUIT_ADDRESS). Seaport's
// ConduitController (0x00000000F9490004C11Cef243f5400493c00Ad63).getConduit(key)
// returns this conduit on each Seaport 1.6 chain above.
export const OPENSEA_FEE_RECIPIENT = '0x0000a26b00c1f0df003000390027140000faa719'
export const OPENSEA_CONDUIT_KEY = '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000'
const OPENSEA_CONDUIT = '0x1e0049783f008a0085193e00003d00cd54003c71'

// Blur, Ethereum only. Exchange V2 proxy: https://docs.blur.foundation/contracts
// ExecutionDelegate: what the Blur Exchange proxy listed there
// (0x000000000000Ad05Ccc4F10045630fb830B95127) returns from executionDelegate().
const BLUR_OPERATORS: Record<string, string> = {
  '0x00000000000111abe46ff893f3b2fdf1f759a8a8': 'the Blur ExecutionDelegate',
  '0xb2ecfe4e4d61f8790bbb9de2d1259b9e2410cea5': 'the Blur Exchange V2',
}

/** The marketplace an NFT setApprovalForAll operator belongs to, or undefined. */
export function nftMarketplaceOperator(chainId: number, operator: string): string | undefined {
  const a = operator.toLowerCase()
  if (a === OPENSEA_CONDUIT && SEAPORT_1_6_CHAINS.has(chainId)) return 'the OpenSea conduit'
  return chainId === 1 ? BLUR_OPERATORS[a] : undefined
}
