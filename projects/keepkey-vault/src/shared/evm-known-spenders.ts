/**
 * Swap and bridge contracts that real dapps ask users to approve, named by
 * KeepKey Desktop. This is Desktop advice only: the device never receives
 * these names (they are not certified name records, see
 * evm-certified-schema.ts CERTIFIED_EVM_NAMES), so a name here changes only
 * the words and the risk level on this computer, never a gate.
 *
 * Each address is copied from the protocol's own deployments list (URL beside
 * it, pinned to a commit where there is one) and was checked on chain
 * 2026-10-29 with eth_getCode via public RPC (publicnode.com for 1, 10, 56,
 * 100, 137, 42161, 43114; mainnet.base.org; rpc.monad.xyz): code present on
 * every chain listed. A chain is listed only where the protocol's list names
 * it. Robinhood Chain (4663) is left out: no public RPC answered the check.
 */
import { REVIEWED_ACROSS_SPOKE_POOLS } from './acrossDeposit'

interface KnownSpender {
  name: string
  /** Lowercase. */
  address: string
  chains: readonly number[]
}

const KNOWN_SPENDERS: KnownSpender[] = [
  // https://github.com/cowprotocol/contracts/blob/c07a93e3596194c5e3cf331c755a3f9f0e4a17d8/networks.json GPv2VaultRelayer.
  // Not GPv2Settlement (0x9008…ab41): CoW orders are filled from the relayer's allowance.
  { name: 'CoW Protocol Vault Relayer', address: '0xc92e8bdf79f0507f65a392b0ab4667716bfe0110', chains: [1, 10, 56, 100, 137, 8453, 42161, 43114] },
  // https://github.com/0xProject/0x-settler/blob/edd3dd4cdd4018d8461c6e5c8f3a9d271cba3806/chain_config.json deployment.allowanceHolder
  { name: '0x AllowanceHolder', address: '0x0000000000001ff3684f28c67538d4d072c22734', chains: [1, 10, 56, 137, 143, 8453, 42161, 43114] },
  // https://github.com/0xProject/protocol/blob/2c8e51e36ccbafa39f7c9003f4087710665acb02/packages/contract-addresses/addresses.json exchangeProxy
  { name: '0x Exchange Proxy', address: '0xdef1c0ded9bec7f1a1670819833240f027b25eff', chains: [1, 56, 137, 8453, 42161, 43114] },
  { name: '0x Exchange Proxy', address: '0xdef1abe32c034e558cdd535791643c58a13acc10', chains: [10] },
  // https://github.com/lifinance/contracts/tree/e8113fdba66b0e577c6e179115fe1c8d0cc623fc/deployments <chain>.json LiFiDiamond
  { name: 'LI.FI Diamond', address: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', chains: [1, 10, 56, 100, 137, 8453, 42161, 43114] },
  { name: 'LI.FI Diamond', address: '0x026f252016a7c47cdef1f05a3fc9e20c92a49c37', chains: [143] },
  // https://github.com/1inch/1inch-sdk-go/blob/321b27436ff7f9ca5d3990006e2d88728780eda0/constants/contracts.go AggregationRouterV6
  // (same address on every chain in constants/chains.go except zkSync)
  { name: '1inch Aggregation Router v6', address: '0x111111125421ca6dc452d289314280a0f8842a65', chains: [1, 10, 56, 100, 137, 8453, 42161, 43114] },
  // https://github.com/VeloraDEX/docs/blob/1bed0fde553fe226795e761d4264930b7d3f98a0/resources/contracts.json augustusV6_2
  { name: 'ParaSwap Augustus v6.2', address: '0x6a000f20005980200259b80c5102003040001068', chains: [1, 10, 56, 100, 137, 8453, 42161, 43114] },
  // https://github.com/odos-xyz/odos-router-v2/blob/21f4124510aa5c1045f9b3eb1ac2cdcacf235ddd/README.md "Chain Deployments"
  { name: 'Odos Router v2', address: '0xcf5540fffcdc3d510b18bfca6d2b9987b0772559', chains: [1] },
  { name: 'Odos Router v2', address: '0xca423977156bb05b13a2ba3b76bc5419e2fe9680', chains: [10] },
  { name: 'Odos Router v2', address: '0x89b8aa89fdd0507a99d334cbe3c808fafc7d850e', chains: [56] },
  { name: 'Odos Router v2', address: '0x4e3288c9ca110bcc82bf38f09a7b425c095d92bf', chains: [137] },
  { name: 'Odos Router v2', address: '0x19ceead7105607cd444f5ad10dd51356436095a1', chains: [8453] },
  { name: 'Odos Router v2', address: '0xa669e7a0d4b3e4fa48af2de86bd4cd7126be4e13', chains: [42161] },
  { name: 'Odos Router v2', address: '0x88de50b233052e4fb783d4f6db78cc34fea3e9fc', chains: [43114] },
  // https://github.com/KyberNetwork/kyberswap-documentation/blob/869880b7643e28fbb6e94bb74026ab29d2e0db3d/developer-guide/aggregator-api/contracts.md MetaAggregationRouterV2
  { name: 'KyberSwap Meta Aggregation Router v2', address: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', chains: [1, 10, 56, 137, 143, 8453, 42161, 43114] },
  // https://github.com/relayprotocol/relay-docs/blob/1d219baf2dbbfc0d0cb8c6d3a22ff0584bb6cc4d/references/api/api_resources/contract-addresses.mdx
  // (v3 and v3.2 Cancun ApprovalProxy; both stay live) and, per chain,
  // https://api.relay.link/chains contracts.approvalProxy / v3.approvalProxy.
  // Not the Relay Receiver (0xa5f5…9934): no Relay flow approves it, and only
  // Relay's solver can call it, so an allowance to it is not a normal request.
  { name: 'Relay Approval Proxy', address: '0x5567954cd026cebfe486062cb75848e0f1c12e58', chains: [1, 10, 56, 100, 137, 143, 8453, 42161, 43114] },
  { name: 'Relay Approval Proxy', address: '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be', chains: [1, 10, 56, 100, 137, 143, 8453, 42161, 43114] },
  // Across SpokePools: the pinned, on-chain-checked list in acrossDeposit.ts
  // (re-checked 2026-10-29 with eth_getCode on 1, 10, 56, 137, 8453, 42161, 43114).
  ...REVIEWED_ACROSS_SPOKE_POOLS.map((p) => ({ name: 'Across SpokePool', address: p.address, chains: [p.chainId] })),
]

/** Desktop's name for a spender contract on this exact chain, else undefined. */
export function knownSpenderName(chainId: number | undefined, address: string | undefined): string | undefined {
  if (!chainId || !address) return undefined
  const a = address.toLowerCase()
  return KNOWN_SPENDERS.find((s) => s.address === a && s.chains.includes(chainId))?.name
}
