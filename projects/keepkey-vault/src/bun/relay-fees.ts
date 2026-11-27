// Tip used when the Relay quote has none. Polygon PoS nodes refuse tips under
// 25 gwei (PIP-35, bor's txpool price limit), so it gets the app's 30 gwei Polygon floor; 1.5 gwei is the usual
// Ethereum inclusion tip and is accepted by the other EIP-1559 chains.
const RELAY_FALLBACK_TIP_WEI: Record<string, bigint> = {
  polygon: 30_000_000_000n,
}
const DEFAULT_FALLBACK_TIP_WEI = 1_500_000_000n

/** The priority fee to start from when a Relay quote does not carry one. */
export function relayFallbackTip(chainId: string): bigint {
  return RELAY_FALLBACK_TIP_WEI[chainId] ?? DEFAULT_FALLBACK_TIP_WEI
}

/**
 * The EIP-1559 fee pair signed on a Relay swap (and its ERC-20 approve).
 *
 * The cap is the Relay quote's own maxFeePerGas, so the pre-sign balance check
 * and the signed tx agree; without a quoted cap it is the live fee. The tip is
 * the quoted maxPriorityFeePerGas, or else the tip chosen in buildRelaySwapTx:
 * relayFallbackTip() for the chain, raised to the live tip when a fee history
 * is available (custom RPC chains; built-in chains read fees through Pioneer,
 * which has none). It is never the cap itself: a tip equal to maxFeePerGas pays
 * the whole cap on every gas unit, often 2–3× the base fee. The tip is capped at
 * maxFeePerGas, which nodes require.
 */
export function relaySignedFees(input: {
  /** Relay quote's maxFeePerGas, when present and EIP-1559 is usable on this chain. */
  quotedMaxFeePerGas?: string | null
  quotedPriorityFeePerGas?: string | null
  /** The fee per gas chosen without the quote (maxFeePerGas or legacy gasPrice). */
  liveFeePerGas: bigint
  /** The tip chosen from the network, when an EIP-1559 fee was built. */
  chosenPriorityFeePerGas?: bigint
}): { signedFeePerGas: bigint; signedPrioFeePerGas: bigint } {
  const signedFeePerGas = input.quotedMaxFeePerGas ? BigInt(input.quotedMaxFeePerGas) : input.liveFeePerGas
  const tip = input.quotedPriorityFeePerGas
    ? BigInt(input.quotedPriorityFeePerGas)
    : input.chosenPriorityFeePerGas ?? signedFeePerGas
  return { signedFeePerGas, signedPrioFeePerGas: tip < signedFeePerGas ? tip : signedFeePerGas }
}
