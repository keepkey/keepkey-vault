/** A plain transfer is executable only for providers that registered the
 * destination off chain. Keep parser, preview and execution on the same rule. */
export function isPlainSwapDeposit(params: {
  fromCaip: string; inboundAddress?: string; memo?: string; swapper?: string; integration?: string
}): boolean {
  if (!params.inboundAddress || params.memo) return false
  if (params.swapper === 'Chainflip') return params.fromCaip.startsWith('bip122:')
  if (params.swapper !== 'NEAR Intents' && params.integration !== 'nearIntents') return false
  // These namespaces have native/token transfer builders. EVM deposits use a
  // prebuilt transaction instead; unsupported namespaces never fall through.
  return /^(bip122|solana|ripple|tron):/.test(params.fromCaip)
}
